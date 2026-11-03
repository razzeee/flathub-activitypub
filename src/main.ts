import { WorkersMessageQueue } from "@fedify/cfworkers";
import type { Message } from "@fedify/fedify";
import { loadConfig, type Variables } from "./config.ts";
import { createApp, handler } from "./server.ts";
import type { CrawlJob } from "./ingestion/ingestor.ts";
import { D1KvStore } from "./store/fedify_kv.ts";
import { logError } from "./log.ts";

export interface IngestionMessage {
  kind: "bootstrap" | "poll";
  id: string;
  continuation?: boolean;
}

export interface Env extends Variables {
  DB: D1Database;
  FEDERATION_QUEUE: Queue;
  INGESTION_QUEUE: Queue<IngestionMessage>;
  FEDERATION_QUEUE_NAME?: string;
  INGESTION_QUEUE_NAME?: string;
}

function createWorkerApp(env: Env) {
  const queue = new WorkersMessageQueue(env.FEDERATION_QUEUE);
  const app = createApp(loadConfig(env), env.DB, queue);
  app.enqueueIngestion = async (kind) => {
    await env.INGESTION_QUEUE.send({ kind, id: crypto.randomUUID() });
  };
  return { app, queue };
}

export async function processIngestion(
  message: IngestionMessage,
  env: Env,
  app = createWorkerApp(env).app,
): Promise<void> {
  const key = `job:${message.kind}`;
  let job = await app.repos.state.get<CrawlJob>(key);
  if (message.continuation && job?.id !== message.id) return; // Stale retry from an earlier run.
  if (job?.id === message.id && job.phase === "done") return;
  // Scheduled ticks also recover a checkpoint whose continuation could not be sent.
  if (!job || job.phase === "done")
    job = await app.ingestor.newJob(message.kind, message.id);
  const next = await app.ingestor.step(job);
  await app.repos.state.set(key, next);
  if (next.phase !== "done") {
    await env.INGESTION_QUEUE.send({
      kind: next.kind,
      id: next.id,
      continuation: true,
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { app } = createWorkerApp(env);
    return handler(app)(request);
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await new D1KvStore(env.DB).prune();
    await env.INGESTION_QUEUE.send({ kind: "poll", id: crypto.randomUUID() });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const { app, queue } = createWorkerApp(env);
    for (const message of batch.messages) {
      try {
        if (batch.queue === (env.INGESTION_QUEUE_NAME ?? "flathub-ingestion")) {
          await processIngestion(message.body as IngestionMessage, env, app);
        } else if (
          batch.queue === (env.FEDERATION_QUEUE_NAME ?? "flathub-federation")
        ) {
          const task = await queue.processMessage(message.body);
          if (!task.shouldProcess) {
            message.retry({ delaySeconds: 30 });
            continue;
          }
          try {
            await app.federation.processQueuedTask(
              { repos: app.repos },
              task.message as Message,
            );
          } finally {
            await task.release?.();
          }
        } else {
          throw new Error(`Unexpected queue: ${batch.queue}`);
        }
        message.ack();
      } catch (error) {
        logError("queue.failed", error, {
          queue: batch.queue,
          messageId: message.id,
        });
        message.retry({
          delaySeconds: Math.min(
            3600,
            30 * 2 ** Math.min(message.attempts - 1, 7),
          ),
        });
      }
    }
  },
} satisfies ExportedHandler<Env>;

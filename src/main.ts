import { loadConfig } from "./config.ts";
import { logError, logEvent } from "./log.ts";
import { createApp, handler } from "./server.ts";

if (import.meta.main) {
  const config = loadConfig();
  if (config.denoKvPath) await ensureParentDirectory(config.denoKvPath);
  const kv = await Deno.openKv(config.denoKvPath);
  const app = createApp(config, kv);
  const handle = handler(app);

  const queueController = new AbortController();
  const serverController = new AbortController();
  let crawlTimer: ReturnType<typeof setInterval> | undefined;
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent("server.shutdown", { signal });
    if (crawlTimer != null) clearInterval(crawlTimer);
    queueController.abort();
    serverController.abort();
  };

  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
  const queue = app.federation.startQueue(
    { repos: app.repos },
    { signal: queueController.signal },
  ).catch((error) => {
    if (!queueController.signal.aborted) logError("fedify_queue.failed", error);
  });

  if (config.crawlIntervalSeconds > 0) {
    crawlTimer = setInterval(() => {
      app.ingestor.poll().catch((error) =>
        logError("scheduled_crawl.failed", error)
      );
    }, config.crawlIntervalSeconds * 1000);
  }

  logEvent("server.start", { origin: config.origin, port: config.port });
  const server = Deno.serve({
    port: config.port,
    signal: serverController.signal,
  }, handle);
  await server.finished.catch((error) => {
    if (!serverController.signal.aborted) throw error;
  });
  await queue;
  kv.close();
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash <= 0) return;
  await Deno.mkdir(filePath.slice(0, lastSlash), { recursive: true });
}

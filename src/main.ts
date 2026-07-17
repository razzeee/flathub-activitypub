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
  Deno.addSignalListener("SIGINT", () => queueController.abort());
  Deno.addSignalListener("SIGTERM", () => queueController.abort());
  app.federation.startQueue(
    { repos: app.repos },
    { signal: queueController.signal },
  ).catch((error) => logError("fedify_queue.failed", error));

  if (config.crawlIntervalSeconds > 0) {
    setInterval(() => {
      app.ingestor.poll().catch((error) =>
        logError("scheduled_crawl.failed", error)
      );
    }, config.crawlIntervalSeconds * 1000);
  }

  logEvent("server.start", { origin: config.origin, port: config.port });
  Deno.serve({ port: config.port }, handle);
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash <= 0) return;
  await Deno.mkdir(filePath.slice(0, lastSlash), { recursive: true });
}

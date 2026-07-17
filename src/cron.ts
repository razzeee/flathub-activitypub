import { loadConfig } from "./config.ts";
import { createApp } from "./server.ts";
import { logError } from "./log.ts";

Deno.cron("flathub activitypub crawler", "*/5 * * * *", async () => {
  const config = loadConfig();
  if (config.crawlScheduler !== "cron" || config.crawlIntervalSeconds === 0) {
    return;
  }
  if (config.denoKvPath) await ensureParentDirectory(config.denoKvPath);
  const kv = await Deno.openKv(config.denoKvPath);
  try {
    await createApp(config, kv).ingestor.poll();
  } catch (error) {
    logError("scheduled_crawl.failed", error);
    throw error;
  } finally {
    kv.close();
  }
});

async function ensureParentDirectory(filePath: string): Promise<void> {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash <= 0) return;
  await Deno.mkdir(filePath.slice(0, lastSlash), { recursive: true });
}

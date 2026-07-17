export interface Config {
  origin: string;
  port: number;
  denoKvPath?: string;
  fedifyQueue: "kv" | "none";
  flathubApiBase: string;
  recentlyUpdatedPerPage: number;
  recentlyUpdatedOverlapSeconds: number;
  crawlScheduler: "interval" | "cron";
  crawlIntervalSeconds: number;
  bootstrapThrottleMs: number;
  internalApiToken?: string;
}

export function loadConfig(env: Deno.Env = Deno.env): Config {
  return {
    origin: stripTrailingSlash(env.get("ORIGIN") ?? "http://localhost:8000"),
    port: readNumber(env, "PORT", 8000),
    denoKvPath: env.get("DENO_KV_PATH") || undefined,
    fedifyQueue: readFedifyQueue(env),
    flathubApiBase: stripTrailingSlash(
      env.get("FLATHUB_API_BASE") ?? "https://flathub.org/api/v2",
    ),
    recentlyUpdatedPerPage: readNumber(env, "RECENTLY_UPDATED_PER_PAGE", 50),
    recentlyUpdatedOverlapSeconds: readNumber(
      env,
      "RECENTLY_UPDATED_OVERLAP_SECONDS",
      3600,
    ),
    crawlScheduler: readCrawlScheduler(env),
    crawlIntervalSeconds: readNumber(env, "CRAWL_INTERVAL_SECONDS", 300),
    bootstrapThrottleMs: readNumber(env, "BOOTSTRAP_THROTTLE_MS", 1000),
    internalApiToken: env.get("INTERNAL_API_TOKEN") || undefined,
  };
}

function readFedifyQueue(env: Deno.Env): "kv" | "none" {
  const value = env.get("FEDIFY_QUEUE") ?? "none";
  if (value === "kv" || value === "none") return value;
  throw new Error("FEDIFY_QUEUE must be 'kv' or 'none'");
}

function readCrawlScheduler(env: Deno.Env): "interval" | "cron" {
  const value = env.get("CRAWL_SCHEDULER") ?? "interval";
  if (value === "interval" || value === "cron") return value;
  throw new Error("CRAWL_SCHEDULER must be 'interval' or 'cron'");
}

function readNumber(env: Deno.Env, name: string, fallback: number): number {
  const value = env.get(name);
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

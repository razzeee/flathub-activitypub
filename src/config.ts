export interface Config {
  origin: string;
  port: number;
  denoKvPath?: string;
  flathubApiBase: string;
  recentlyUpdatedPerPage: number;
  recentlyUpdatedOverlapSeconds: number;
  crawlIntervalSeconds: number;
  bootstrapThrottleMs: number;
  internalApiToken?: string;
}

export function loadConfig(env: Deno.Env = Deno.env): Config {
  return {
    origin: stripTrailingSlash(env.get("ORIGIN") ?? "http://localhost:8000"),
    port: readNumber(env, "PORT", 8000),
    denoKvPath: env.get("DENO_KV_PATH") || undefined,
    flathubApiBase: stripTrailingSlash(
      env.get("FLATHUB_API_BASE") ?? "https://flathub.org/api/v2",
    ),
    recentlyUpdatedPerPage: readNumber(env, "RECENTLY_UPDATED_PER_PAGE", 50),
    recentlyUpdatedOverlapSeconds: readNumber(
      env,
      "RECENTLY_UPDATED_OVERLAP_SECONDS",
      3600,
    ),
    crawlIntervalSeconds: readNumber(env, "CRAWL_INTERVAL_SECONDS", 300),
    bootstrapThrottleMs: readNumber(env, "BOOTSTRAP_THROTTLE_MS", 1000),
    internalApiToken: env.get("INTERNAL_API_TOKEN") || undefined,
  };
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

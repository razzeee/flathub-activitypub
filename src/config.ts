export interface Config {
  origin: string;
  flathubApiBase: string;
  recentlyUpdatedPerPage: number;
  recentlyUpdatedOverlapSeconds: number;
  internalApiToken?: string;
  fedifyQueue: "cloudflare" | "none";
  crawlScheduler: "cron";
}

export interface Variables {
  ORIGIN?: string;
  FLATHUB_API_BASE?: string;
  RECENTLY_UPDATED_PER_PAGE?: string;
  RECENTLY_UPDATED_OVERLAP_SECONDS?: string;
  INTERNAL_API_TOKEN?: string;
}

export function loadConfig(env: Variables): Config {
  const origin = new URL(env.ORIGIN ?? "http://localhost:8787");
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("ORIGIN must be an HTTP(S) origin");
  }
  if (
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error(
      "ORIGIN must not include a path, credentials, query or fragment",
    );
  }
  return {
    origin: origin.origin,
    flathubApiBase: (
      env.FLATHUB_API_BASE ?? "https://flathub.org/api/v2"
    ).replace(/\/+$/, ""),
    recentlyUpdatedPerPage: readNumber(env.RECENTLY_UPDATED_PER_PAGE, 10, 1),
    recentlyUpdatedOverlapSeconds: readNumber(
      env.RECENTLY_UPDATED_OVERLAP_SECONDS,
      3600,
      0,
    ),
    internalApiToken: env.INTERNAL_API_TOKEN || undefined,
    fedifyQueue: "cloudflare",
    crawlScheduler: "cron",
  };
}

function readNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Expected an integer >= ${minimum}, got ${value}`);
  }
  return parsed;
}

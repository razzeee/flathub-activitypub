export interface RecentlyUpdatedHit {
  appId: string;
  name: string;
  summary?: string;
  iconUrl?: string;
  updatedAt: number;
}

export interface RecentlyUpdatedPage {
  page: number;
  hitsPerPage: number;
  totalPages: number;
  totalHits: number;
  hits: RecentlyUpdatedHit[];
}

export interface AppstreamRelease {
  version?: string;
  timestamp?: number | string;
  date?: string;
  type?: string;
  urgency?: string;
  description?: string;
  url?: string;
}

export interface AppstreamApp {
  appId: string;
  name?: string;
  summary?: string;
  iconUrl?: string;
  releases: AppstreamRelease[];
}

export class FlathubClient {
  constructor(
    private readonly apiBase: string,
    private readonly fetcher = fetch,
  ) {}

  async recentlyUpdated(
    page: number,
    perPage: number,
  ): Promise<RecentlyUpdatedPage> {
    const url = new URL(`${this.apiBase}/collection/recently-updated`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("locale", "en");
    const json = await this.fetchJson(url);
    return parseRecentlyUpdatedPage(json);
  }

  async appstream(appId: string): Promise<AppstreamApp> {
    const url = new URL(
      `${this.apiBase}/appstream/${encodeURIComponent(appId)}`,
    );
    url.searchParams.set("locale", "en");
    const json = await this.fetchJson(url);
    return parseAppstreamApp(appId, json);
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const response = await retry(async () => await this.fetcher(url));
    if (!response.ok) {
      throw new Error(`Flathub request failed: ${response.status} ${url}`);
    }
    return await response.json();
  }
}

export function parseRecentlyUpdatedPage(input: unknown): RecentlyUpdatedPage {
  if (!isRecord(input)) {
    throw new Error("recently-updated response must be an object");
  }
  const hits = Array.isArray(input.hits) ? input.hits : [];
  return {
    page: asNumber(input.page, 1),
    hitsPerPage: asNumber(input.hitsPerPage, hits.length),
    totalPages: asNumber(input.totalPages, 1),
    totalHits: asNumber(input.totalHits, hits.length),
    hits: hits.map(parseRecentlyUpdatedHit).filter((hit) => hit.appId !== ""),
  };
}

export function parseAppstreamApp(appId: string, input: unknown): AppstreamApp {
  if (!isRecord(input)) throw new Error("appstream response must be an object");
  return {
    appId,
    name: asOptionalString(input.name),
    summary: asOptionalString(input.summary),
    iconUrl: asOptionalString(input.icon),
    releases: Array.isArray(input.releases)
      ? input.releases.map(parseRelease)
      : [],
  };
}

function parseRecentlyUpdatedHit(input: unknown): RecentlyUpdatedHit {
  if (!isRecord(input)) return { appId: "", name: "", updatedAt: 0 };
  return {
    appId: asString(input.app_id),
    name: asString(input.name),
    summary: asOptionalString(input.summary),
    iconUrl: asOptionalString(input.icon),
    updatedAt: asNumber(input.updated_at, 0),
  };
}

function parseRelease(input: unknown): AppstreamRelease {
  if (!isRecord(input)) return {};
  return {
    version: asOptionalString(input.version),
    timestamp:
      typeof input.timestamp === "number" || typeof input.timestamp === "string"
        ? input.timestamp
        : undefined,
    date: asOptionalString(input.date),
    type: asOptionalString(input.type),
    urgency: asOptionalString(input.urgency),
    description: asOptionalString(input.description),
    url: asOptionalString(input.url),
  };
}

async function retry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await delay(100 * 2 ** attempt);
    }
  }
  throw lastError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalString(value: unknown): string | undefined {
  const string = asString(value);
  return string === "" ? undefined : string;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

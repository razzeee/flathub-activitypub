import type {
  AppstreamApp,
  FlathubClient,
  RecentlyUpdatedPage,
} from "../flathub/client.ts";
import type { FlathubCollectionName } from "../federation/collections.ts";

export class FakeFlathubClient implements
  Pick<
    FlathubClient,
    "recentlyUpdated" | "recentlyAdded" | "collection" | "appstream"
  > {
  pages = new Map<number, RecentlyUpdatedPage>();
  addedPages = new Map<number, RecentlyUpdatedPage>();
  collectionPages = new Map<string, RecentlyUpdatedPage>();
  apps = new Map<string, AppstreamApp>();

  recentlyUpdated(page: number): Promise<RecentlyUpdatedPage> {
    const result = this.pages.get(page);
    if (!result) throw new Error(`missing page ${page}`);
    return Promise.resolve(result);
  }

  recentlyAdded(page: number): Promise<RecentlyUpdatedPage> {
    const result = this.addedPages.get(page) ?? emptyPage(page);
    return Promise.resolve(result);
  }

  collection(
    collection: FlathubCollectionName,
    page: number,
  ): Promise<RecentlyUpdatedPage> {
    if (collection === "recently-updated") return this.recentlyUpdated(page);
    if (collection === "recently-added") return this.recentlyAdded(page);
    const result = this.collectionPages.get(`${collection}:${page}`) ??
      emptyPage(page);
    return Promise.resolve(result);
  }

  appstream(appId: string): Promise<AppstreamApp> {
    const result = this.apps.get(appId);
    if (!result) throw new Error(`missing app ${appId}`);
    return Promise.resolve(result);
  }
}

function emptyPage(page: number): RecentlyUpdatedPage {
  return { page, hitsPerPage: 0, totalPages: 1, totalHits: 0, hits: [] };
}

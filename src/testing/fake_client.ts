import type {
  AppstreamApp,
  FlathubClient,
  RecentlyUpdatedPage,
} from "../flathub/client.ts";

export class FakeFlathubClient
  implements Pick<FlathubClient, "recentlyUpdated" | "appstream"> {
  pages = new Map<number, RecentlyUpdatedPage>();
  apps = new Map<string, AppstreamApp>();

  recentlyUpdated(page: number): Promise<RecentlyUpdatedPage> {
    const result = this.pages.get(page);
    if (!result) throw new Error(`missing page ${page}`);
    return Promise.resolve(result);
  }

  appstream(appId: string): Promise<AppstreamApp> {
    const result = this.apps.get(appId);
    if (!result) throw new Error(`missing app ${appId}`);
    return Promise.resolve(result);
  }
}

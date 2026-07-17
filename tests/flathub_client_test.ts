import { assertEquals } from "@std/assert";
import {
  parseAppstreamApp,
  parseRecentlyUpdatedPage,
} from "../src/flathub/client.ts";

Deno.test("parseRecentlyUpdatedPage maps Flathub fields", () => {
  const page = parseRecentlyUpdatedPage({
    page: 2,
    hitsPerPage: 1,
    totalPages: 3,
    totalHits: 3,
    hits: [{
      app_id: "org.mozilla.firefox",
      name: "Firefox",
      summary: "Browser",
      icon: "https://example/icon.png",
      updated_at: 123,
    }],
  });

  assertEquals(page.hits[0], {
    appId: "org.mozilla.firefox",
    name: "Firefox",
    summary: "Browser",
    iconUrl: "https://example/icon.png",
    updatedAt: 123,
  });
});

Deno.test("parseAppstreamApp keeps release fields", () => {
  const app = parseAppstreamApp("org.example.App", {
    name: "Example",
    releases: [{
      version: "1.0",
      timestamp: 42,
      description: "<p>Fixed bugs</p>",
    }],
  });

  assertEquals(app.appId, "org.example.App");
  assertEquals(app.releases[0].version, "1.0");
});

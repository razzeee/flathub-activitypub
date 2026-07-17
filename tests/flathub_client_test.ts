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
      added_at: 99,
    }],
  });

  assertEquals(page.hits[0], {
    appId: "org.mozilla.firefox",
    name: "Firefox",
    summary: "Browser",
    iconUrl: "https://example/icon.png",
    updatedAt: 123,
    addedAt: 99,
  });
});

Deno.test("parseAppstreamApp keeps release fields", () => {
  const app = parseAppstreamApp("org.example.App", {
    name: "Example",
    summary: "Example summary",
    description: "<p>Example description</p>",
    icon: "https://example/icon.png",
    releases: [{
      version: "1.0",
      timestamp: 42,
      description: "<p>Fixed bugs</p>",
    }],
  });

  assertEquals(app.appId, "org.example.App");
  assertEquals(app.name, "Example");
  assertEquals(app.summary, "Example summary");
  assertEquals(app.description, "<p>Example description</p>");
  assertEquals(app.iconUrl, "https://example/icon.png");
  assertEquals(app.releases[0].version, "1.0");
});

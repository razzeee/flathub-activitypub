import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  buildNoteContent,
  latestRelease,
  normalizeRelease,
  releasePublishedAt,
  sanitizeHtml,
} from "../src/releases.ts";

Deno.test("normalizeRelease skips empty descriptions", async () => {
  assertEquals(
    await normalizeRelease("org.example.App", {
      version: "1",
      description: "  ",
    }),
    null,
  );
});

Deno.test("normalizeRelease fingerprint changes when description changes", async () => {
  const first = await normalizeRelease("org.example.App", {
    version: "1",
    date: "2026-07-10",
    description: "<p>A</p>",
  });
  const second = await normalizeRelease("org.example.App", {
    version: "1",
    date: "2026-07-10",
    description: "<p>B</p>",
  });
  assert(first);
  assert(second);
  assertNotEquals(first.fingerprint, second.fingerprint);
});

Deno.test("sanitizeHtml removes scripts and event handlers", () => {
  assertEquals(
    sanitizeHtml('<p onclick="evil()">Safe</p><script>alert(1)</script>'),
    "<p>Safe</p>",
  );
});

Deno.test("sanitizeHtml removes unquoted unsafe URL attributes", () => {
  assertEquals(
    sanitizeHtml(
      "<a href=javascript:alert(1)>x</a><img src=data:text/html,evil>",
    ),
    "<a>x</a>",
  );
});

Deno.test("sanitizeHtml drops dangerous tags and attributes", () => {
  assertEquals(
    sanitizeHtml(
      '<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="https://example.com/x"></object><p class="x">Safe</p>',
    ),
    "<p>Safe</p>",
  );
});

Deno.test("sanitizeHtml preserves safe formatting and links", () => {
  assertEquals(
    sanitizeHtml(
      '<p>See <a href="https://example.com/release">release</a></p><ul><li><strong>Fix</strong></li></ul>',
    ),
    '<p>See <a href="https://example.com/release">release</a></p><ul><li><strong>Fix</strong></li></ul>',
  );
});

Deno.test("buildNoteContent includes release and Flathub link", async () => {
  const release = await normalizeRelease("org.example.App", {
    version: "1.2",
    date: "2026-07-10",
    description: "<p>Changes</p>",
  });
  assert(release);
  const html = buildNoteContent("Example", "org.example.App", release);
  assert(html.includes("Example 1.2"));
  assert(html.includes("https://flathub.org/apps/org.example.App"));
  assert(html.includes("#Flathub #LinuxApps"));
});

Deno.test("latestRelease ignores future-dated releases", async () => {
  const now = new Date("2026-07-17T12:00:00.000Z");
  const current = await normalizeRelease("io.github.ezQuake", {
    version: "3.6.9",
    timestamp: "1772323200",
    description: "<p>Current</p>",
  });
  const future = await normalizeRelease("io.github.ezQuake", {
    version: "3.6.7",
    timestamp: "1789430400",
    description: "<p>Future metadata</p>",
  });

  assert(current);
  assert(future);
  assertEquals(latestRelease([current, future], now)?.version, "3.6.9");
  assertEquals(latestRelease([future], now), undefined);
});

Deno.test("releasePublishedAt does not return a future instant", async () => {
  const fallback = new Date("2026-07-17T12:00:00.000Z");
  const release = await normalizeRelease("io.github.ezQuake", {
    version: "3.6.7",
    timestamp: "1789430400",
    description: "<p>Future metadata</p>",
  });

  assert(release);
  assertEquals(releasePublishedAt(release, fallback), fallback.toISOString());
});

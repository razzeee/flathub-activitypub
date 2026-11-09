import { expect, test } from "vitest";
import { actorDocument, appActorSummary } from "../src/federation/activity.ts";
import type { AppProfile } from "../src/store/types.ts";

const profile: AppProfile = {
  appId: "org.kde.haruna",
  name: "Haruna",
  summary: "  Play videos & music  ",
  descriptionHtml: "<p>Long description</p><ul><li>Feature list</li></ul>",
  flathubUrl: "https://flathub.org/apps/org.kde.haruna",
  lastSeenUpdatedAt: 1,
  createdAt: "2026-11-09T00:00:00Z",
  updatedAt: "2026-11-09T00:00:00Z",
};

test("app bios use the short summary and a separate unofficial feed notice", () => {
  expect(appActorSummary(profile)).toBe(
    "<p>Play videos &amp; music</p>\n" +
      "<p>Unofficial release feed from Flathub. Not affiliated with the app developers.</p>",
  );
});

test.each([undefined, "", "   "])(
  "app bios without a summary do not fall back to the full description (%s)",
  (summary) => {
    expect(appActorSummary({ ...profile, summary })).toBe(
      "<p>Unofficial release feed from Flathub. Not affiliated with the app developers.</p>",
    );
  },
);

test("actor documents expose a Flathub profile field", () => {
  const actor = actorDocument("https://example.org", profile);
  expect(actor.summary).toBe(appActorSummary(profile));
  expect(actor.attachment).toEqual([{
    type: "PropertyValue",
    name: "Flathub",
    value: '<a href="https://flathub.org/apps/org.kde.haruna" rel="me">org.kde.haruna</a>',
  }]);
});

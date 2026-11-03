import { readFile } from "node:fs/promises";
import { parseConfigFileTextToJson } from "typescript";
import { expect, test } from "vitest";
import { productionConfig } from "../scripts/production-config.ts";

test("deployment enables public Worker-to-Worker federation routing", async () => {
  const source = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const parsed = parseConfigFileTextToJson("wrangler.jsonc", source);
  expect(parsed.error).toBeUndefined();
  expect(parsed.config.compatibility_flags).toContain(
    "global_fetch_strictly_public",
  );
  expect(parsed.config.compatibility_flags).toContain("nodejs_compat");
});

const base = {
  name: "flathub-activitypub",
  main: "src/main.ts",
  vars: { ORIGIN: "http://localhost:8787" },
  d1_databases: [{ binding: "DB", migrations_dir: "migrations" }],
  queues: { consumers: [{ queue: "flathub-federation" }] },
  triggers: { crons: ["*/5 * * * *"] },
};
const productionEnv = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  PRODUCTION_D1_DATABASE_ID: "12345678-1234-1234-1234-123456789abc",
  PRODUCTION_ORIGIN: "https://activitypub.flathub.org",
};

test("production config binds a custom domain and preserves queues and cron", () => {
  const config = productionConfig(base, productionEnv, "/repo");
  expect(config.vars.ORIGIN).toBe(productionEnv.PRODUCTION_ORIGIN);
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
  expect(config.routes).toEqual([
    { pattern: "activitypub.flathub.org", custom_domain: true },
  ]);
  expect(config.d1_databases[0]).toMatchObject({
    database_id: productionEnv.PRODUCTION_D1_DATABASE_ID,
    migrations_dir: "/repo/migrations",
  });
  expect(config.main).toBe("/repo/src/main.ts");
  expect(config.queues).toEqual(base.queues);
  expect(config.triggers).toEqual(base.triggers);
  expect(base.vars.ORIGIN).toBe("http://localhost:8787");
});

test("production supports an explicitly selected workers.dev identity", () => {
  const config = productionConfig(
    base,
    {
      ...productionEnv,
      PRODUCTION_ORIGIN: "https://flathub-activitypub.account.workers.dev",
    },
    "/repo",
  );
  expect(config.workers_dev).toBe(true);
  expect(config.routes).toEqual([]);
});

test.each([
  "http://activitypub.flathub.org",
  "https://localhost",
  "https://service.localhost",
  "https://service.local",
  "https://127.0.0.1",
  "https://[::1]",
  "https://example.com",
  "https://activitypub.flathub.org/",
  "https://activitypub.flathub.org/path",
  "https://activitypub.flathub.org?query=1",
  "https://user:password@activitypub.flathub.org",
  "https://activitypub.flathub.org:8443",
  "https://flathub-ap-validation.account.workers.dev",
  "",
])("production rejects unsafe or noncanonical origin %s", (origin) => {
  expect(() =>
    productionConfig(
      base,
      { ...productionEnv, PRODUCTION_ORIGIN: origin },
      "/repo",
    ),
  ).toThrow();
});

test.each([
  { CLOUDFLARE_ACCOUNT_ID: "" },
  { PRODUCTION_D1_DATABASE_ID: "" },
  { PRODUCTION_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000" },
])("production rejects missing or placeholder resources %j", (env) => {
  expect(() =>
    productionConfig(base, { ...productionEnv, ...env }, "/repo"),
  ).toThrow();
});

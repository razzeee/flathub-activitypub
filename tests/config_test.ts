import { readFile } from "node:fs/promises";
import { parseConfigFileTextToJson } from "typescript";
import { expect, test } from "vitest";

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

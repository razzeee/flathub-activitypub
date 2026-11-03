import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import {
  deepStrictEqual,
  notDeepStrictEqual,
  ok,
  rejects,
} from "node:assert/strict";

export {
  deepStrictEqual as assertEquals,
  notDeepStrictEqual as assertNotEquals,
  ok as assert,
};
export function assertStringIncludes(actual: string, expected: string): void {
  ok(
    actual.includes(expected),
    `Expected string to contain ${JSON.stringify(expected)}`,
  );
}
export async function assertRejects(
  fn: () => Promise<unknown>,
  error: ErrorConstructor,
  message: string,
): Promise<void> {
  await rejects(
    fn,
    (caught: unknown) =>
      caught instanceof error && caught.message.includes(message),
  );
}

export async function openDatabase() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      compatibilityDate: "2026-11-03",
      d1Databases: ["DB"],
    }),
  );
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  const migration = await readFile(
    new URL("../migrations/0001_initial.sql", import.meta.url),
    "utf8",
  );
  await db.exec(migration);
  return { db, close: () => mf.dispose() };
}

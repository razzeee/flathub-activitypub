import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Convert the old application's JSONL KV export into an import for an empty D1 database. */
export function convertDenoExport(jsonl: string): string {
  const statements: string[] = [];
  const feeds = new Map<string, { appId: string; rank: number }[]>();
  const quote = (value: unknown): string => {
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
    if (typeof value !== "string")
      throw new Error("Invalid exported key or index value");
    return `'${value.replaceAll("'", "''")}'`;
  };
  const insert = (table: string, values: unknown[]) => {
    statements.push(
      `INSERT INTO ${table} VALUES (${values.map(quote).join(", ")});`,
    );
  };
  for (const line of jsonl.split("\n").filter((line) => line.trim() !== "")) {
    const entry: unknown = JSON.parse(line);
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("key" in entry) ||
      !("value" in entry) ||
      !Array.isArray(entry.key)
    ) {
      throw new Error("Expected JSONL entries with key and value fields");
    }
    const [kind, id, subId] = entry.key;
    if (
      ![
        "app",
        "release",
        "post",
        "follower",
        "keypair",
        "feedApp",
        "crawl",
        "bootstrap",
      ].includes(kind)
    )
      continue;
    const value = entry.value;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error(`Invalid ${kind} record`);
    const data = JSON.stringify(value);
    if (kind === "app") {
      if (!("lastSeenUpdatedAt" in value))
        throw new Error("Missing app timestamp");
      insert("apps", [id, value.lastSeenUpdatedAt, data]);
    } else if (kind === "release") insert("releases", [id, subId, data]);
    else if (kind === "post") {
      if (!("publishedAt" in value)) throw new Error("Missing post timestamp");
      insert("posts", [
        id,
        subId,
        "kind" in value ? value.kind : "release",
        value.publishedAt,
        data,
      ]);
    } else if (kind === "follower") insert("followers", [id, subId, data]);
    else if (kind === "keypair") insert("actor_keys", [id, subId, data]);
    else if (kind === "crawl") insert("state", [id, data]);
    else if (kind === "bootstrap") insert("state", ["bootstrap", data]);
    else if (kind === "feedApp") {
      if (
        typeof id !== "string" ||
        !("appId" in value) ||
        typeof value.appId !== "string" ||
        !("rank" in value) ||
        typeof value.rank !== "number"
      )
        throw new Error("Invalid feed entry");
      const entries = feeds.get(id) ?? [];
      entries.push({ appId: value.appId, rank: value.rank });
      feeds.set(id, entries);
    }
  }
  for (const [id, entries] of feeds) {
    insert("feed_snapshots", [
      id,
      JSON.stringify(
        entries.sort((a, b) => a.rank - b.rank).map((entry) => entry.appId),
      ),
    ]);
  }
  // No OR REPLACE: importing into a populated database must fail rather than rotate signing keys.
  return statements.join("\n") + "\n";
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , input, output] = process.argv;
  if (!input || !output)
    throw new Error("Usage: pnpm db:convert-deno <export.jsonl> <import.sql>");
  await writeFile(output, convertDenoExport(await readFile(input, "utf8")), {
    mode: 0o600,
    flag: "wx",
  });
}

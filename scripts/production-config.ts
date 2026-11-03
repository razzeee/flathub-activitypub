import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseConfigFileTextToJson } from "typescript";

export function productionConfig(
  base: Record<string, any>,
  env: Record<string, string | undefined>,
  root: string,
): Record<string, any> {
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const database = env.PRODUCTION_D1_DATABASE_ID ?? "";
  if (!/^[a-f0-9]{32}$/i.test(account)) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID to the production account ID.");
  }
  if (
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database) ||
    database === "00000000-0000-0000-0000-000000000000"
  ) {
    throw new Error(
      "Set PRODUCTION_D1_DATABASE_ID to a provisioned database UUID.",
    );
  }
  const origin = new URL(env.PRODUCTION_ORIGIN ?? "");
  if (
    origin.protocol !== "https:" ||
    origin.origin !== env.PRODUCTION_ORIGIN ||
    origin.port ||
    !origin.hostname.includes(".") ||
    isIP(origin.hostname.replace(/^\[|\]$/g, "")) ||
    /(^|\.)(localhost|local|test|invalid|example)$/.test(origin.hostname) ||
    /(^|\.)example\.(com|org|net)$/.test(origin.hostname)
  ) {
    throw new Error(
      "PRODUCTION_ORIGIN must be a public HTTPS origin without a path or trailing slash.",
    );
  }
  const workersDev = origin.hostname.endsWith(".workers.dev");
  if (workersDev && !origin.hostname.startsWith(`${base.name}.`)) {
    throw new Error(
      "The workers.dev origin must match the production Worker name.",
    );
  }
  return {
    ...base,
    account_id: account,
    main: resolve(root, base.main),
    workers_dev: workersDev,
    preview_urls: false,
    routes: workersDev
      ? []
      : [{ pattern: origin.hostname, custom_domain: true }],
    vars: { ...base.vars, ORIGIN: origin.origin },
    d1_databases: [
      {
        ...base.d1_databases[0],
        database_id: database,
        migrations_dir: resolve(root, base.d1_databases[0].migrations_dir),
      },
    ],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = process.cwd();
  const parsed = parseConfigFileTextToJson(
    "wrangler.jsonc",
    await readFile(resolve(root, "wrangler.jsonc"), "utf8"),
  );
  if (parsed.error) throw new Error("Invalid wrangler.jsonc");
  const config = productionConfig(parsed.config, process.env, root);
  await mkdir(resolve(root, ".data"), { recursive: true });
  await writeFile(
    resolve(root, ".data/wrangler.production.json"),
    JSON.stringify(config, null, 2),
  );
  console.log(
    "Validated production configuration written to .data/wrangler.production.json",
  );
}

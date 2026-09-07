import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, closePool } from "../src/db.js";

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");

/**
 * Rebuilds the schema from scratch. This drops data, so it refuses to run
 * against anything but a database whose name is explicitly whitelisted for
 * development, unless ALLOW_DESTRUCTIVE=1 is set deliberately.
 */
const DEV_DATABASES = new Set(["northwind", "northwind_test"]);

async function main(): Promise<void> {
  const url = new URL(pool.options.connectionString!);
  const dbName = url.pathname.replace(/^\//, "");
  if (!DEV_DATABASES.has(dbName) && process.env.ALLOW_DESTRUCTIVE !== "1") {
    throw new Error(
      `refusing to rebuild schema on database "${dbName}"; ` +
      `set ALLOW_DESTRUCTIVE=1 if that is really what you want`);
  }

  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  for (const file of readdirSync(sqlDir).filter((f) => f.endsWith(".sql")).sort()) {
    process.stdout.write(`applying ${file} ... `);
    await pool.query(readFileSync(join(sqlDir, file), "utf8"));
    console.log("ok");
  }

  const counts = await pool.query<{ tables: string; triggers: string; checks: string }>(
    `SELECT (SELECT count(*) FROM information_schema.tables
              WHERE table_schema='public' AND table_type='BASE TABLE')::text AS tables,
            (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)::text AS triggers,
            (SELECT count(*) FROM pg_constraint
              WHERE contype='c' AND connamespace='public'::regnamespace)::text AS checks`);
  console.log("schema:", counts.rows[0]);
}

main().then(closePool).catch(async (err) => {
  console.error(err.message);
  await closePool();
  process.exit(1);
});

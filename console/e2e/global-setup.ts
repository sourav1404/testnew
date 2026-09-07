import { execFileSync } from "node:child_process";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The console lives at <repo>/console, so the backend is one level up. */
const BACKEND = process.env.ERP_BACKEND_DIR
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A known starting point. The console shows real backend state, so the tests
 * need the backend at a state they can reason about -- otherwise an assertion
 * about availability is really an assertion about whatever ran last.
 *
 * Products are reference data and the Stage 2 API has no endpoint that creates
 * them, so those go in directly. Everything else in the tests goes through the
 * API.
 */
export default function globalSetup(): void {
  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { cwd: BACKEND, stdio: "pipe", encoding: "utf8" });

  run("npm", ["run", "migrate", "--silent"]);
  run("npm", ["run", "seed", "--silent"]);

  const skus = ["E2E-A", "E2E-B", "E2E-C", "E2E-D", "E2E-E"];
  const values = skus.map((s) => `('${s}','${s}')`).join(",");
  execFileSync("docker", [
    "exec", "erp-pg", "psql", "-U", "postgres", "-d", "northwind", "-c",
    `INSERT INTO products (sku,name) VALUES ${values} ON CONFLICT DO NOTHING;`,
  ], { stdio: "pipe" });

  console.log(`  [setup] backend reset; e2e products: ${skus.join(", ")}`);
}

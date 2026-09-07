import pg from "pg";

// numeric/int8 come back as strings by default. Money and quantities stay
// strings all the way to JSON on purpose -- a float would silently lose the
// cent that this whole system exists to keep track of.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://postgres:erp@localhost:55432/northwind",
  max: Number(process.env.PG_POOL_MAX ?? 20),
});

export type Tx = pg.PoolClient;

/**
 * One business event, one transaction. Every service function below takes a Tx
 * rather than reaching for the pool, so a caller cannot accidentally split a
 * goods receipt and its journal entry across two transactions.
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    // Deferred constraint triggers (ledger_entry_complete, movement_ties_to_ledger,
    // reversal_mirrors_original) would otherwise fire during COMMIT, outside any
    // handler. Forcing them here converts a commit-time failure into a normal
    // rejection that the error mapper can turn into a real status code.
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

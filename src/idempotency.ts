import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { type Tx, withTx } from "./db.js";
import { ApiError } from "./errors.js";

/**
 * Key order must not change the hash. `JSON.stringify` preserves insertion
 * order, so two clients sending the same receipt with `{qty, po_line_id}` and
 * `{po_line_id, qty}` produced different hashes, and the retry was rejected as
 * a key reuse instead of replayed.
 */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(",")}}`;
}

/**
 * Exported so a test can construct the same hash the middleware will compute,
 * and so the canonicalisation is unit-testable on its own.
 */
export function requestHash(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method} ${path}\n${canonical(body ?? null)}`)
    .digest("hex");
}

const hashOf = (req: Request): string =>
  requestHash(req.method, `${req.baseUrl}${req.path}`, req.body ?? null);

/**
 * A claim whose response was never written is abandoned after this long and may
 * be taken over. In this design the claim and the effect share a transaction,
 * so a crash rolls the claim back and a committed response_code = 0 should be
 * unreachable -- but "should be unreachable" is not a reclaim path, and without
 * one such a row would answer 409 forever with no way out. Measured: rolling
 * back after the claim leaves zero rows behind, so this is a backstop for a
 * future writer that does not share the transaction, not for this one.
 */
const ABANDONED_AFTER = "5 minutes";

/** Rows older than this are purged; the table grew without bound before. */
const RETAIN_KEYS_FOR = "30 days";

/**
 * Runs a mutating handler exactly once per Idempotency-Key.
 *
 * The claim row and the effect are written in the SAME transaction, which is
 * the only arrangement that works: if the handler fails, the claim rolls back
 * with it and a retry is free to proceed; if it commits, a retry finds the
 * stored response and replays it without touching stock or the ledger. A
 * separate "have I seen this key" table written outside the transaction would
 * let a crash between the two leave the key claimed and the work undone, and
 * the retry would then be told "already handled" for something that never
 * happened.
 *
 * The key is scoped to (endpoint, key) and carries a canonical request hash, so
 * the same key on a different endpoint, or with a different body, is a conflict
 * rather than a silent replay of the wrong response.
 */
export async function runIdempotent<T>(
  req: Request, res: Response, successCode: number, fn: (tx: Tx) => Promise<T>,
): Promise<void> {
  const key = req.header("idempotency-key");
  if (!key) {
    res.status(successCode).json(await withTx(fn));
    return;
  }

  const endpoint = `${req.method} ${req.route?.path ?? req.path}`;
  const requestHash = hashOf(req);

  const outcome = await withTx(async (tx) => {
    // Claim the key, or take over a claim that was abandoned mid-flight.
    const claim = await tx.query(
      `INSERT INTO idempotency_keys (endpoint, key, request_hash, response_code, response_body)
       VALUES ($1, $2, $3, 0, '{}'::jsonb)
       ON CONFLICT (endpoint, key) DO UPDATE
          SET request_hash = EXCLUDED.request_hash, created_at = now()
        WHERE idempotency_keys.response_code = 0
          AND idempotency_keys.created_at < now() - $4::interval
       RETURNING 1`,
      [endpoint, key, requestHash, ABANDONED_AFTER]);

    if (claim.rowCount === 0) {
      const prior = await tx.query<{
        request_hash: string; response_code: number; response_body: unknown;
      }>(`SELECT request_hash, response_code, response_body
            FROM idempotency_keys WHERE endpoint = $1 AND key = $2`, [endpoint, key]);
      const row = prior.rows[0]!;
      if (row.request_hash !== requestHash) {
        throw new ApiError(409, "idempotency_key_reuse",
          "this Idempotency-Key was already used with a different request body");
      }
      if (row.response_code === 0) {
        throw new ApiError(409, "request_in_flight",
          `a request with this Idempotency-Key is still being processed; it becomes reclaimable after ${ABANDONED_AFTER}`);
      }
      return { code: row.response_code, body: row.response_body, replayed: true };
    }

    const body = await fn(tx);
    await tx.query(
      `UPDATE idempotency_keys SET response_code = $3, response_body = $4
        WHERE endpoint = $1 AND key = $2`,
      [endpoint, key, successCode, JSON.stringify(body)]);
    return { code: successCode, body, replayed: false };
  });

  res.status(outcome.code)
     .set("Idempotent-Replay", String(outcome.replayed))
     .json(outcome.body);
}

/** Run by the same scheduler that drives the reservation sweep. */
export async function purgeIdempotencyKeys(tx: Tx): Promise<number> {
  const r = await tx.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - $1::interval`,
    [RETAIN_KEYS_FOR]);
  return r.rowCount ?? 0;
}

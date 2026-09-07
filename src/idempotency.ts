import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { type Tx, withTx } from "./db.js";
import { ApiError } from "./errors.js";

const hashOf = (req: Request): string =>
  createHash("sha256")
    .update(`${req.method} ${req.baseUrl}${req.path}\n${JSON.stringify(req.body ?? null)}`)
    .digest("hex");

/**
 * Runs a mutating handler exactly once per Idempotency-Key.
 *
 * The claim row and the effect are written in the SAME transaction, which is
 * the only arrangement that actually works: if the handler fails, the claim
 * rolls back with it and a retry is free to proceed; if it commits, a retry
 * finds the stored response and replays it without touching stock or the
 * ledger. A separate "have I seen this key" table written outside the
 * transaction would let a crash between the two leave the key claimed and the
 * work undone -- the retry would then be told "already handled" for something
 * that never happened.
 *
 * The key is scoped to (endpoint, key) and carries a request hash, so the same
 * key reused on a different endpoint or with a different body is a conflict
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
    const claim = await tx.query(
      `INSERT INTO idempotency_keys (endpoint, key, request_hash, response_code, response_body)
       VALUES ($1, $2, $3, 0, '{}'::jsonb)
       ON CONFLICT (endpoint, key) DO NOTHING`,
      [endpoint, key, requestHash]);

    if (claim.rowCount === 0) {
      const prior = await tx.query<{ request_hash: string; response_code: number; response_body: unknown }>(
        `SELECT request_hash, response_code, response_body
           FROM idempotency_keys WHERE endpoint = $1 AND key = $2`, [endpoint, key]);
      const row = prior.rows[0]!;
      if (row.request_hash !== requestHash) {
        throw new ApiError(409, "idempotency_key_reuse",
          "this Idempotency-Key was already used with a different request body");
      }
      if (row.response_code === 0) {
        // A concurrent request holds the claim and has not committed yet.
        throw new ApiError(409, "request_in_flight",
          "a request with this Idempotency-Key is still being processed");
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

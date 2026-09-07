import type { NextFunction, Request, Response } from "express";

/**
 * The operations console runs on its own origin in development, so the API has
 * to answer preflights. Hand-rolled rather than pulling in a dependency,
 * because there are only four decisions to make and they are all worth stating:
 *
 *  - The allow-list is explicit. `*` would work here, but this API carries a
 *    bearer token, and a wildcard origin plus credentials is the combination
 *    browsers refuse anyway.
 *  - `idempotency-key` has to be in allow-headers or the browser strips the one
 *    header that makes a retried receipt safe.
 *  - `Idempotent-Replay` has to be in expose-headers or the console cannot tell
 *    a fresh 201 from a replayed one.
 *  - The preflight is answered BEFORE authenticate(), because an OPTIONS
 *    request carries no Authorization header and would otherwise 401.
 */
const ALLOWED = new Set(
  (process.env.CORS_ORIGINS ?? "http://localhost:5174,http://127.0.0.1:5174")
    .split(",").map((o) => o.trim()).filter(Boolean),
);

export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header("origin");
  if (origin && ALLOWED.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers",
      "authorization, content-type, idempotency-key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "Idempotent-Replay");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") {
    res.status(origin && ALLOWED.has(origin) ? 204 : 403).end();
    return;
  }
  next();
}

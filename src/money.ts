import { ApiError } from "./errors.js";

/**
 * Exact decimal arithmetic on the string values that come out of, and go back
 * into, `numeric` columns.
 *
 * db.ts keeps money and quantities as strings all the way to JSON on the
 * grounds that "a float would silently lose the cent that this whole system
 * exists to keep track of" -- and then the service layer was doing
 * `Number(a) * Number(b)` and calling `.toFixed(2)` on the result, which is
 * exactly the thing that comment warns about. A concrete loss:
 *
 *     (1.005).toFixed(2) === "1.00"      // should be "1.01"
 *     0.1 * 3             === 0.30000000000000004
 *     0.07 * 100          === 7.000000000000001
 *
 * Everything here is integer arithmetic on BigInt scaled to WORK_DP places,
 * so a value that a `numeric(14,4)` column can hold round-trips unchanged and
 * rounding is half-away-from-zero, matching Postgres `round()`.
 */
const WORK_DP = 8;
const WORK_SCALE = 10n ** BigInt(WORK_DP);

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

function scaled(v: string, field: string): bigint {
  const m = DECIMAL.exec(v.trim());
  if (!m) throw new ApiError(400, "bad_request", `${field} is not a decimal: ${v}`);
  const frac = m[3] ?? "";
  if (frac.length > WORK_DP) {
    throw new ApiError(400, "bad_request",
      `${field} has more than ${WORK_DP} decimal places: ${v}`);
  }
  const digits = m[2]! + frac.padEnd(WORK_DP, "0");
  const magnitude = BigInt(digits);
  return m[1] === "-" ? -magnitude : magnitude;
}

/** Half away from zero, so -0.005 -> -0.01 and 0.005 -> 0.01, as Postgres does. */
function unscale(u: bigint, dp: number): string {
  const drop = 10n ** BigInt(WORK_DP - dp);
  const negative = u < 0n;
  const abs = negative ? -u : u;
  const q = abs / drop;
  const rounded = abs % drop * 2n >= drop ? q + 1n : q;
  const s = rounded.toString().padStart(dp + 1, "0");
  const out = dp === 0 ? s : `${s.slice(0, -dp)}.${s.slice(-dp)}`;
  return negative && rounded !== 0n ? `-${out}` : out;
}

export const money = {
  /** a * b, rounded to `dp` places. */
  mul(a: string, b: string, dp = 2, field = "value"): string {
    return unscale(scaled(a, field) * scaled(b, field) / WORK_SCALE, dp);
  },
  add(a: string, b: string, dp = 2, field = "value"): string {
    return unscale(scaled(a, field) + scaled(b, field), dp);
  },
  sum(values: readonly string[], dp = 2, field = "value"): string {
    return unscale(values.reduce((acc, v) => acc + scaled(v, field), 0n), dp);
  },
  neg(a: string, dp = 2, field = "value"): string {
    return unscale(-scaled(a, field), dp);
  },
  sub(a: string, b: string, dp = 2, field = "value"): string {
    return unscale(scaled(a, field) - scaled(b, field), dp);
  },
  /** -1, 0 or 1. Used wherever a quantity comparison decided a business rule. */
  cmp(a: string, b: string, field = "value"): -1 | 0 | 1 {
    const x = scaled(a, field), y = scaled(b, field);
    return x < y ? -1 : x > y ? 1 : 0;
  },
  isZero(a: string, field = "value"): boolean { return scaled(a, field) === 0n; },
  /** Re-render at a fixed scale without arithmetic, e.g. "1" -> "1.0000". */
  at(a: string, dp: number, field = "value"): string {
    return unscale(scaled(a, field), dp);
  },
};

/** A failure the caller can do something about. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * The database is the last word on the invariants, so its errors are the ones
 * clients see. Mapping them here -- rather than pre-checking in the service and
 * hoping the check and the constraint agree -- means there is exactly one
 * definition of each rule.
 */
const BY_SQLSTATE: Record<string, [number, string]> = {
  ERP01: [409, "incompatible_roles"],
  ERP02: [409, "immutable_ledger"],
  ERP03: [422, "unbalanced_entry"],
  ERP04: [403, "control_account_direct_post"],
  ERP05: [409, "period_closed"],
  ERP06: [422, "reversal_mismatch"],
  ERP07: [422, "subledger_ledger_mismatch"],
  ERP08: [409, "reservation_terminal"],
  ERP09: [403, "projection_is_read_only"],
  ERP10: [422, "over_receipt"],
  ERP11: [409, "purchase_order_frozen"],
  "23505": [409, "duplicate"],
  "23503": [422, "unknown_reference"],
  "40001": [503, "serialization_failure"],
  "40P01": [503, "deadlock"],
};

const BY_CONSTRAINT: Record<string, [number, string]> = {
  no_oversell: [409, "insufficient_stock"],
  po_maker_checker: [403, "separation_of_duties"],
  po_within_limit: [403, "approval_limit_exceeded"],
  sol_not_over_fulfilled: [422, "over_fulfilment"],
  one_live_hold_per_line: [409, "reservation_exists"],
  users_email_ci: [409, "duplicate_email"],
};

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const e = err as { code?: string; constraint?: string; message?: string };

  const byConstraint = e.constraint ? BY_CONSTRAINT[e.constraint] : undefined;
  if (byConstraint) {
    return new ApiError(byConstraint[0], byConstraint[1], e.message ?? "rejected");
  }
  const bySqlstate = e.code ? BY_SQLSTATE[e.code] : undefined;
  if (bySqlstate) {
    return new ApiError(bySqlstate[0], bySqlstate[1], e.message ?? "rejected");
  }

  // Anything the database rejects is a client problem, not a server problem.
  // Without this fallback every CHECK constraint I had not hand-mapped above
  // came back as a 500 -- a probe found ordered_qty <= 0 and a non-numeric
  // unit_price both doing exactly that. Class 23 is integrity constraint
  // violation and class 22 is data exception, so both are the caller's fault.
  const code = e.code ?? "";
  if (code.startsWith("23")) {
    return new ApiError(422, "constraint_violation",
      e.message ?? "rejected", e.constraint ? { constraint: e.constraint } : undefined);
  }
  if (code.startsWith("22")) {
    return new ApiError(400, "bad_request", e.message ?? "malformed value");
  }
  return new ApiError(500, "internal_error", "unexpected failure");
}

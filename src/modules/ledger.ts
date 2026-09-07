import type { Tx } from "../db.js";
import { ApiError } from "../errors.js";
import { money } from "../money.js";

export interface EntryLine {
  account: string;
  /** Positive debits, negative credits. Inventory lines must carry product+warehouse. */
  amount: string;
  productId?: number;
  warehouseId?: number;
}

export interface PostEntryInput {
  entryDate?: string;
  sourceDoc: string;
  sourceDocId: number;
  memo?: string;
  createdBy: number;
  lines: EntryLine[];
  reversesId?: number;
}

/**
 * Writes one journal entry. The header goes in first because guard_ledger_line
 * reads ledger_entries on every line insert; the entry is therefore line-less
 * and illegal for an instant, which is legal only because ledger_entry_complete
 * is DEFERRABLE INITIALLY DEFERRED. withTx() forces the deferred checks before
 * COMMIT so an unbalanced entry surfaces as a 422 rather than a commit failure.
 */
export async function postEntry(tx: Tx, input: PostEntryInput): Promise<number> {
  if (input.lines.length < 2) {
    throw new ApiError(422, "unbalanced_entry", "a journal entry needs at least two lines");
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO ledger_entries (entry_date, source_doc, source_doc_id, memo, reverses_id, created_by)
     VALUES (COALESCE($1::date, current_date), $2, $3, $4, $5, $6) RETURNING id`,
    [input.entryDate ?? null, input.sourceDoc, input.sourceDocId, input.memo ?? null,
     input.reversesId ?? null, input.createdBy],
  );
  const entryId = Number(rows[0]!.id);

  for (const line of input.lines) {
    await tx.query(
      `INSERT INTO ledger_lines (entry_id, account_code, amount, product_id, warehouse_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [entryId, line.account, line.amount, line.productId ?? null, line.warehouseId ?? null],
    );
  }
  return entryId;
}

/**
 * The only legal correction. Posted entries are immutable -- ledger_entries has
 * a BEFORE UPDATE OR DELETE trigger -- so a mistake is undone by posting its
 * exact negation, and reversal_mirrors_original refuses anything that is not.
 */
export async function reverseEntry(
  tx: Tx, originalId: number, actorId: number, memo: string,
): Promise<number> {
  const original = await tx.query<{ id: string; source_doc: string; source_doc_id: string }>(
    `SELECT id, source_doc, source_doc_id FROM ledger_entries WHERE id = $1`, [originalId],
  );
  if (!original.rows[0]) throw new ApiError(404, "not_found", `entry ${originalId} does not exist`);

  const already = await tx.query(
    `SELECT 1 FROM ledger_entries WHERE reverses_id = $1`, [originalId],
  );
  if (already.rowCount) {
    throw new ApiError(409, "already_reversed", `entry ${originalId} has already been reversed`);
  }

  // A bare ledger reversal is only correct for an entry with no subledger behind
  // it. Reversing a goods receipt or a shipment would move account 1300 while
  // leaving the stock movement in place, and the two would stop tying -- the one
  // invariant this system exists to hold. Those are corrected by posting a
  // compensating stock movement, which brings its own balanced entry with it.
  const backed = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM stock_movements WHERE ledger_entry_id = $1`, [originalId],
  );
  if (Number(backed.rows[0]!.n) > 0) {
    throw new ApiError(409, "reversal_would_break_reconciliation",
      `entry ${originalId} books ${backed.rows[0]!.n} stock movement(s); ` +
      `reverse it with a compensating inventory adjustment, not a ledger reversal`,
      { stock_movements: Number(backed.rows[0]!.n),
        use_instead: "POST /inventory/adjustments" });
  }

  const lines = await tx.query<{
    account_code: string; amount: string; product_id: string | null; warehouse_id: string | null;
  }>(`SELECT account_code, amount, product_id, warehouse_id FROM ledger_lines WHERE entry_id = $1`,
     [originalId]);

  return postEntry(tx, {
    sourceDoc: original.rows[0].source_doc,
    sourceDocId: Number(original.rows[0].source_doc_id),
    memo,
    createdBy: actorId,
    reversesId: originalId,
    lines: lines.rows.map((l) => ({
      account: l.account_code,
      amount: money.neg(l.amount),
      productId: l.product_id ? Number(l.product_id) : undefined,
      warehouseId: l.warehouse_id ? Number(l.warehouse_id) : undefined,
    })),
  });
}

export async function trialBalance(tx: Tx, asOf?: string) {
  const { rows } = await tx.query(
    `SELECT a.code, a.name, a.kind, COALESCE(SUM(l.amount), 0)::text AS balance
       FROM accounts a
       LEFT JOIN ledger_lines l   ON l.account_code = a.code
       LEFT JOIN ledger_entries e ON e.id = l.entry_id
        AND ($1::date IS NULL OR e.entry_date <= $1::date)
      GROUP BY a.code, a.name, a.kind
      ORDER BY a.code`, [asOf ?? null]);
  const total = money.sum(rows.map((r) => String(r.balance)));
  return { as_of: asOf ?? null, accounts: rows, total_must_be_zero: total };
}

/**
 * Requirement 3: total inventory value computed from stock movements, checked
 * against the Inventory control account. Both sides use booked_value, a stored
 * generated column, so there is one rounded figure rather than two rounding
 * strategies that drift apart at scale.
 */
export async function reconcileInventory(tx: Tx, asOf?: string) {
  const { rows } = await tx.query<{
    subledger_value: string; gl_value: string; delta: string; unbalanced_entries: string;
  }>(
    `WITH sub AS (
       -- Filtered by the entry's accounting date, not the movement's physical
       -- created_at. An as_of report is an accounting question, and the two
       -- columns can disagree: a movement written just after midnight against
       -- an entry dated the previous day would land on opposite sides of the
       -- cutoff and manufacture a delta that does not exist.
       SELECT COALESCE(SUM(m.booked_value), 0) AS v
         FROM stock_movements m JOIN ledger_entries e2 ON e2.id = m.ledger_entry_id
        WHERE $1::date IS NULL OR e2.entry_date <= $1::date),
     gl AS (
       SELECT COALESCE(SUM(l.amount), 0) AS v
         FROM ledger_lines l JOIN ledger_entries e ON e.id = l.entry_id
        WHERE l.account_code = '1300' AND ($1::date IS NULL OR e.entry_date <= $1::date)),
     bad AS (
       SELECT count(*) AS n FROM (
         SELECT entry_id FROM ledger_lines GROUP BY entry_id HAVING SUM(amount) <> 0) q)
     SELECT sub.v::text AS subledger_value, gl.v::text AS gl_value,
            (sub.v - gl.v)::text AS delta, bad.n::text AS unbalanced_entries
       FROM sub, gl, bad`, [asOf ?? null]);

  const r = rows[0]!;
  const byProduct = await tx.query(
    `SELECT p.sku, w.code AS warehouse, b.on_hand_qty::text, b.reserved_qty::text,
            b.avg_unit_cost::text, round(b.on_hand_qty * b.avg_unit_cost, 2)::text AS value
       FROM stock_balances b
       JOIN products p ON p.id = b.product_id
       JOIN warehouses w ON w.id = b.warehouse_id
      ORDER BY p.sku, w.code`);

  return {
    as_of: asOf ?? null,
    subledger_value: r.subledger_value,
    gl_inventory_value: r.gl_value,
    delta: r.delta,
    unbalanced_entries: Number(r.unbalanced_entries),
    status: money.isZero(r.delta) && Number(r.unbalanced_entries) === 0 ? "TIES" : "DRIFT",
    by_product: byProduct.rows,
  };
}

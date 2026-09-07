import type { Tx } from "../db.js";
import { ApiError } from "../errors.js";
import { postEntry } from "./ledger.js";

export interface SoLineInput { sku: string; warehouse: string; qty: string; unitPrice: string }

export async function createSalesOrder(
  tx: Tx, input: { soNumber: string; customerCode: string; lines: SoLineInput[]; actorId: number },
) {
  const customer = await tx.query<{ id: string }>(
    `SELECT id FROM customers WHERE code = $1 AND is_active`, [input.customerCode]);
  if (!customer.rows[0]) {
    throw new ApiError(422, "unknown_reference", `unknown customer ${input.customerCode}`);
  }
  const so = await tx.query<{ id: string }>(
    `INSERT INTO sales_orders (so_number, customer_id, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.soNumber, customer.rows[0].id, input.actorId]);
  const soId = Number(so.rows[0]!.id);

  for (const line of input.lines) {
    await tx.query(
      `INSERT INTO sales_order_lines (so_id, product_id, warehouse_id, qty, unit_price)
       SELECT $1, p.id, w.id, $4, $5 FROM products p, warehouses w
        WHERE p.sku = $2 AND w.code = $3`,
      [soId, line.sku, line.warehouse, line.qty, line.unitPrice]);
  }
  return { sales_order_id: soId, status: "DRAFT" };
}

/**
 * Requirement 2 and objective 3: the reservation path, and the only place in
 * this codebase whose correctness depends on a lock rather than a constraint.
 *
 * Every balance row the order touches is locked up front, in one statement,
 * ordered by (product_id, warehouse_id). Two facts make this the right shape:
 *
 *  - Ordering removes deadlocks. LockRows sits above Sort in the plan, so the
 *    locks are taken in sorted order no matter which line the caller listed
 *    first. Reserving line-by-line instead lets two orders over the same two
 *    SKUs in opposite order deadlock (40P01), which is measured in the tests.
 *  - Locking before reading removes the race. Under READ COMMITTED, FOR UPDATE
 *    re-reads the row after the lock is granted, so the loser of a race sees
 *    the winner's committed effect rather than its own opening snapshot.
 *
 * no_oversell on stock_balances stays as the backstop for any path that skips
 * this function; it should never be the thing that fires in normal operation.
 */
export async function confirmSalesOrder(tx: Tx, soId: number, ttlMinutes: number, actorId: number) {
  const so = await tx.query<{ status: string }>(
    `SELECT status FROM sales_orders WHERE id = $1`, [soId]);
  if (!so.rows[0]) throw new ApiError(404, "not_found", `sales order ${soId} not found`);
  if (so.rows[0].status === "CANCELLED") {
    throw new ApiError(409, "cancelled", `sales order ${soId} is cancelled`);
  }

  await tx.query(
    `SELECT 1 FROM stock_balances b
      WHERE (b.product_id, b.warehouse_id) IN
            (SELECT l.product_id, l.warehouse_id FROM sales_order_lines l WHERE l.so_id = $1)
      ORDER BY b.product_id, b.warehouse_id
      FOR UPDATE`, [soId]);

  // Read availability only now that every relevant row is pinned.
  const lines = await tx.query<{
    id: string; product_id: string; warehouse_id: string; sku: string;
    want: string; available: string; held: string;
  }>(
    `SELECT l.id, l.product_id, l.warehouse_id, p.sku,
            (l.qty - l.fulfilled_qty)::text AS want,
            COALESCE(b.on_hand_qty - b.reserved_qty, 0)::text AS available,
            COALESCE((SELECT SUM(r.qty) FROM stock_reservations r
                       WHERE r.sales_order_line_id = l.id AND r.status = 'HELD'), 0)::text AS held
       FROM sales_order_lines l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN stock_balances b
         ON b.product_id = l.product_id AND b.warehouse_id = l.warehouse_id
      WHERE l.so_id = $1
      ORDER BY l.product_id, l.warehouse_id`, [soId]);

  const results = [];
  for (const line of lines.rows) {
    const outstanding = Number(line.want) - Number(line.held);
    if (outstanding <= 0) {
      results.push({ sku: line.sku, reserved: "0", backordered: "0", note: "already held" });
      continue;
    }
    // Partial reservation is deliberate: reserve what exists, backorder the
    // rest, rather than refusing the whole order because one line is short.
    const take = Math.min(outstanding, Number(line.available));
    if (take > 0) {
      await tx.query(
        `INSERT INTO stock_reservations
           (sales_order_line_id, product_id, warehouse_id, qty, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)`,
        [line.id, line.product_id, line.warehouse_id, take.toFixed(4), String(ttlMinutes)]);
    }
    results.push({
      sku: line.sku,
      reserved: take.toFixed(4),
      backordered: (outstanding - take).toFixed(4),
    });
  }

  await tx.query(`UPDATE sales_orders SET status = 'CONFIRMED' WHERE id = $1 AND status = 'DRAFT'`,
    [soId]);
  void actorId;
  return { sales_order_id: soId, status: "CONFIRMED", lines: results };
}

/**
 * Requirement 5. Ships whatever is actually held and leaves the rest
 * backordered. Two journal entries per shipment, because cost and revenue are
 * different economic facts: DR COGS / CR Inventory, and DR Receivables /
 * CR Revenue.
 */
export async function fulfilSalesOrder(tx: Tx, soId: number, actorId: number) {
  const so = await tx.query<{ status: string }>(
    `SELECT status FROM sales_orders WHERE id = $1`, [soId]);
  if (!so.rows[0]) throw new ApiError(404, "not_found", `sales order ${soId} not found`);

  await tx.query(
    `SELECT 1 FROM stock_balances b
      WHERE (b.product_id, b.warehouse_id) IN
            (SELECT l.product_id, l.warehouse_id FROM sales_order_lines l WHERE l.so_id = $1)
      ORDER BY b.product_id, b.warehouse_id
      FOR UPDATE`, [soId]);

  const lines = await tx.query<{
    id: string; product_id: string; warehouse_id: string; sku: string; unit_price: string;
  }>(
    `SELECT l.id, l.product_id, l.warehouse_id, p.sku, l.unit_price::text
       FROM sales_order_lines l JOIN products p ON p.id = l.product_id
      WHERE l.so_id = $1 ORDER BY l.product_id, l.warehouse_id`, [soId]);

  const cogsLines = []; const shipped = [];
  let cogsTotal = 0; let revenueTotal = 0;

  for (const line of lines.rows) {
    // Consume conditionally in one statement. Never read-then-act: the expiry
    // sweep may be running right now, and this UPDATE is the arbitration point.
    const claim = await tx.query<{ qty: string }>(
      `UPDATE stock_reservations SET status = 'CONSUMED'
        WHERE sales_order_line_id = $1 AND status = 'HELD' AND expires_at > now()
        RETURNING qty::text`, [line.id]);
    const taken = claim.rows[0]?.qty;
    if (!taken) { shipped.push({ sku: line.sku, shipped: "0", reason: "no live reservation" }); continue; }

    const balance = await tx.query<{ avg_unit_cost: string }>(
      `SELECT avg_unit_cost::text FROM stock_balances
        WHERE product_id = $1 AND warehouse_id = $2`, [line.product_id, line.warehouse_id]);
    const avgCost = balance.rows[0]?.avg_unit_cost ?? "0";
    const value = (Number(taken) * Number(avgCost)).toFixed(2);

    cogsLines.push({
      account: "1300", amount: (-Number(value)).toFixed(2),
      productId: Number(line.product_id), warehouseId: Number(line.warehouse_id),
    });
    cogsTotal += Number(value);
    revenueTotal += Number((Number(taken) * Number(line.unit_price)).toFixed(2));
    shipped.push({ sku: line.sku, shipped: taken, unit_cost: avgCost, cogs: value });
  }

  if (cogsLines.length === 0) {
    throw new ApiError(409, "nothing_to_ship",
      `sales order ${soId} has no live reservation to ship`);
  }

  const cogsEntry = await postEntry(tx, {
    sourceDoc: "fulfilment", sourceDocId: soId, memo: `COGS for SO ${soId}`,
    createdBy: actorId,
    lines: [...cogsLines, { account: "5000", amount: cogsTotal.toFixed(2) }],
  });
  const revenueEntry = await postEntry(tx, {
    sourceDoc: "fulfilment", sourceDocId: soId, memo: `Revenue for SO ${soId}`,
    createdBy: actorId,
    lines: [
      { account: "1200", amount: revenueTotal.toFixed(2) },
      { account: "4000", amount: (-revenueTotal).toFixed(2) },
    ],
  });

  // Movements after the entry, so each cites a ledger_entry_id that already
  // posts the matching Inventory figure.
  for (const line of lines.rows) {
    const s = shipped.find((x) => x.sku === line.sku);
    if (!s || s.shipped === "0") continue;
    await tx.query(
      `INSERT INTO stock_movements
         (product_id, warehouse_id, qty_delta, unit_cost, movement_type,
          source_doc, source_doc_id, ledger_entry_id, created_by)
       VALUES ($1, $2, $3, $4, 'SALES_ISSUE', 'fulfilment', $5, $6, $7)`,
      [line.product_id, line.warehouse_id, (-Number(s.shipped)).toFixed(4),
       s.unit_cost, soId, cogsEntry, actorId]);
    await tx.query(
      `UPDATE sales_order_lines SET fulfilled_qty = fulfilled_qty + $2 WHERE id = $1`,
      [line.id, s.shipped]);
  }

  // Status is derived from the lines, never from a counter kept in step by hand.
  const open = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sales_order_lines
      WHERE so_id = $1 AND fulfilled_qty < qty`, [soId]);
  const status = Number(open.rows[0]!.n) === 0 ? "FULFILLED" : "PARTIALLY_FULFILLED";
  await tx.query(`UPDATE sales_orders SET status = $2 WHERE id = $1`, [soId, status]);

  return {
    sales_order_id: soId, status,
    cogs_entry_id: cogsEntry, revenue_entry_id: revenueEntry,
    cogs_total: cogsTotal.toFixed(2), revenue_total: revenueTotal.toFixed(2),
    lines: shipped,
  };
}

export async function salesOrderStatus(tx: Tx, soId: number) {
  const so = await tx.query(
    `SELECT id::text, so_number, status, created_at FROM sales_orders WHERE id = $1`, [soId]);
  if (!so.rows[0]) throw new ApiError(404, "not_found", `sales order ${soId} not found`);
  const lines = await tx.query(
    `SELECT s.id::text, p.sku, w.code AS warehouse, s.qty::text, s.fulfilled_qty::text,
            s.backordered_qty::text, s.line_status, s.unit_price::text,
            COALESCE((SELECT SUM(r.qty) FROM stock_reservations r
                       WHERE r.sales_order_line_id = s.id AND r.status = 'HELD'), 0)::text AS held_qty
       FROM sales_order_line_status s
       JOIN products p ON p.id = s.product_id
       JOIN warehouses w ON w.id = s.warehouse_id
      WHERE s.so_id = $1 ORDER BY s.id`, [soId]);
  return { ...so.rows[0], lines: lines.rows };
}

/**
 * The expiry sweep. Balance locks are taken FIRST, in the same global order the
 * reservation and fulfilment paths use -- the natural order here would be
 * reservations then balances, which is the opposite of fulfilment and would
 * deadlock under load. SKIP LOCKED lets several schedulers run; the
 * status = 'HELD' re-check is what makes it idempotent and stops it fighting a
 * checkout that already consumed the hold.
 */
export async function expireReservations(tx: Tx, batch = 500): Promise<number> {
  const candidates = await tx.query<{ id: string }>(
    `SELECT id FROM stock_reservations
      WHERE status = 'HELD' AND expires_at < now()
      ORDER BY expires_at LIMIT $1`, [batch]);
  if (candidates.rowCount === 0) return 0;
  const ids = candidates.rows.map((r) => r.id);

  await tx.query(
    `SELECT 1 FROM stock_balances b
      WHERE (b.product_id, b.warehouse_id) IN
            (SELECT r.product_id, r.warehouse_id FROM stock_reservations r
              WHERE r.id = ANY($1::bigint[]))
      ORDER BY b.product_id, b.warehouse_id
      FOR UPDATE`, [ids]);

  const done = await tx.query(
    `WITH claimed AS (
       SELECT id FROM stock_reservations
        WHERE id = ANY($1::bigint[]) AND status = 'HELD' AND expires_at < now()
        FOR UPDATE SKIP LOCKED)
     UPDATE stock_reservations s SET status = 'EXPIRED'
       FROM claimed c WHERE s.id = c.id AND s.status = 'HELD'`, [ids]);
  return done.rowCount ?? 0;
}

import type { Tx } from "../db.js";
import { ApiError } from "../errors.js";
import { money } from "../money.js";
import { resolveLocation } from "./inventory.js";
import { postEntry } from "./ledger.js";

export interface SoLineInput { sku: string; warehouse: string; qty: string; unitPrice: string }

export async function createSalesOrder(
  tx: Tx, input: { soNumber: string; customerCode: string; lines: SoLineInput[]; actorId: number },
) {
  // Same asymmetry the procurement side had: an order with no lines is not an
  // order. A probe confirmed a zero-line sales order was accepted and then
  // happily reported CONFIRMED with an empty line list.
  if (input.lines.length === 0) {
    throw new ApiError(422, "empty_order", "a sales order needs at least one line");
  }
  const customer = await tx.query<{ id: string }>(
    `SELECT id FROM customers WHERE code = $1 AND is_active`, [input.customerCode]);
  if (!customer.rows[0]) {
    throw new ApiError(422, "unknown_reference", `unknown customer ${input.customerCode}`);
  }

  // Resolve before writing, so an unknown sku/warehouse is a 422 rather than a
  // sales order with zero lines.
  const resolved = [];
  for (const line of input.lines) {
    resolved.push({ line, loc: await resolveLocation(tx, line.sku, line.warehouse) });
  }

  const so = await tx.query<{ id: string }>(
    `INSERT INTO sales_orders (so_number, customer_id, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.soNumber, customer.rows[0].id, input.actorId]);
  const soId = Number(so.rows[0]!.id);

  for (const { line, loc } of resolved) {
    const ins = await tx.query(
      `INSERT INTO sales_order_lines (so_id, product_id, warehouse_id, qty, unit_price)
       VALUES ($1, $2, $3, $4, $5)`,
      [soId, loc.productId, loc.warehouseId, line.qty, line.unitPrice]);
    if (ins.rowCount !== 1) {
      throw new ApiError(500, "internal_error", "sales order line was not written");
    }
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
    // Quantities are numeric(14,4); all arithmetic goes through money.ts so a
    // float cannot round a quantity into or out of existence.
    const outstanding = money.sub(line.want, line.held, 4, "qty");
    if (money.cmp(outstanding, "0") <= 0) {
      results.push({ sku: line.sku, reserved: "0.0000", backordered: "0.0000",
                     note: "already held" });
      continue;
    }
    // Partial reservation is deliberate: reserve what exists, backorder the
    // rest, rather than refusing the whole order because one line is short.
    const available = money.cmp(line.available, "0") > 0
      ? money.at(line.available, 4, "available") : "0.0000";
    const take = money.cmp(outstanding, available) <= 0 ? outstanding : available;
    if (money.cmp(take, "0") > 0) {
      await tx.query(
        `INSERT INTO stock_reservations
           (sales_order_line_id, product_id, warehouse_id, qty, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)`,
        [line.id, line.product_id, line.warehouse_id, take, String(ttlMinutes)]);
    }
    results.push({
      sku: line.sku,
      reserved: take,
      backordered: money.sub(outstanding, take, 4, "qty"),
    });
  }

  // Record who committed the stock. This is the one privileged act on a sales
  // order and it previously left no trace.
  await tx.query(
    `UPDATE sales_orders
        SET status = 'CONFIRMED', confirmed_by = $2, confirmed_at = now()
      WHERE id = $1 AND status = 'DRAFT'`, [soId, actorId]);
  return { sales_order_id: soId, status: "CONFIRMED", confirmed_by: actorId, lines: results };
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
  const cogsAmounts: string[] = []; const revenueAmounts: string[] = [];

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
    const value = money.mul(taken, avgCost, 2, "avg_unit_cost");

    cogsLines.push({
      account: "1300", amount: money.neg(value),
      productId: Number(line.product_id), warehouseId: Number(line.warehouse_id),
    });
    cogsAmounts.push(value);
    revenueAmounts.push(money.mul(taken, line.unit_price, 2, "unit_price"));
    shipped.push({ sku: line.sku, shipped: taken, unit_cost: avgCost, cogs: value });
  }

  if (cogsLines.length === 0) {
    throw new ApiError(409, "nothing_to_ship",
      `sales order ${soId} has no live reservation to ship`);
  }

  const cogsEntry = await postEntry(tx, {
    sourceDoc: "fulfilment", sourceDocId: soId, memo: `COGS for SO ${soId}`,
    createdBy: actorId,
    lines: [...cogsLines, { account: "5000", amount: money.sum(cogsAmounts) }],
  });
  const revenueEntry = await postEntry(tx, {
    sourceDoc: "fulfilment", sourceDocId: soId, memo: `Revenue for SO ${soId}`,
    createdBy: actorId,
    lines: [
      { account: "1200", amount: money.sum(revenueAmounts) },
      { account: "4000", amount: money.neg(money.sum(revenueAmounts)) },
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
      [line.product_id, line.warehouse_id, money.neg(s.shipped, 4, "shipped"),
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
    cogs_total: money.sum(cogsAmounts), revenue_total: money.sum(revenueAmounts),
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

import type { Tx } from "../db.js";
import { ApiError } from "../errors.js";
import { money } from "../money.js";
import { postEntry } from "./ledger.js";

/** Current stock, derived. There is no quantity_on_hand column anywhere. */
export async function availability(tx: Tx, sku?: string, warehouse?: string) {
  const { rows } = await tx.query(
    `SELECT p.sku, w.code AS warehouse,
            b.on_hand_qty::text, b.reserved_qty::text,
            (b.on_hand_qty - b.reserved_qty)::text AS available,
            b.avg_unit_cost::text
       FROM stock_balances b
       JOIN products p   ON p.id = b.product_id
       JOIN warehouses w ON w.id = b.warehouse_id
      WHERE ($1::text IS NULL OR p.sku = $1) AND ($2::text IS NULL OR w.code = $2)
      ORDER BY p.sku, w.code`, [sku ?? null, warehouse ?? null]);
  return rows;
}

/**
 * The append-only movement ledger itself. Deliberately exposed, because the
 * derived balance above is only trustworthy if the events behind it are
 * inspectable.
 */
export async function movements(tx: Tx, sku?: string, limit = 100) {
  const { rows } = await tx.query(
    `SELECT m.id, p.sku, w.code AS warehouse, m.qty_delta::text, m.unit_cost::text,
            m.booked_value::text, m.movement_type, m.source_doc, m.source_doc_id::text,
            m.ledger_entry_id::text, m.created_at
       FROM stock_movements m
       JOIN products p   ON p.id = m.product_id
       JOIN warehouses w ON w.id = m.warehouse_id
      WHERE $1::text IS NULL OR p.sku = $1
      ORDER BY m.id DESC LIMIT $2`, [sku ?? null, limit]);
  return rows;
}

export interface AdjustmentInput {
  sku: string;
  warehouse: string;
  qtyDelta: string;
  reason: string;
  actorId: number;
}

/**
 * A correction to stock is a new movement, never an edit of an old one. It is
 * valued at the current moving average, and books the difference to Inventory
 * Adjustment so the control account still ties.
 */
export async function postAdjustment(tx: Tx, input: AdjustmentInput) {
  const loc = await resolveLocation(tx, input.sku, input.warehouse);

  // Lock before reading the cost we are about to value the movement at, so a
  // concurrent receipt cannot move the average between the read and the write.
  const balance = await tx.query<{ avg_unit_cost: string }>(
    `SELECT avg_unit_cost FROM stock_balances
      WHERE product_id = $1 AND warehouse_id = $2 FOR UPDATE`,
    [loc.productId, loc.warehouseId]);

  const unitCost = balance.rows[0]?.avg_unit_cost ?? "0";
  const bookedValue = money.mul(input.qtyDelta, unitCost, 2, "qty_delta");

  const entryId = await postEntry(tx, {
    sourceDoc: "inventory_adjustment",
    sourceDocId: loc.productId,
    memo: input.reason,
    createdBy: input.actorId,
    lines: [
      { account: "1300", amount: bookedValue, productId: loc.productId, warehouseId: loc.warehouseId },
      { account: "5900", amount: money.neg(bookedValue) },
    ],
  });

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO stock_movements
       (product_id, warehouse_id, qty_delta, unit_cost, movement_type,
        source_doc, source_doc_id, ledger_entry_id, created_by)
     VALUES ($1, $2, $3, $4, 'ADJUSTMENT', 'inventory_adjustment', $1, $5, $6)
     RETURNING id`,
    [loc.productId, loc.warehouseId, input.qtyDelta, unitCost, entryId, input.actorId]);

  return { stock_movement_id: rows[0]!.id, ledger_entry_id: entryId, booked_value: bookedValue };
}

export async function resolveLocation(tx: Tx, sku: string, warehouse: string) {
  const { rows } = await tx.query<{ product_id: string; warehouse_id: string }>(
    `SELECT p.id AS product_id, w.id AS warehouse_id
       FROM products p, warehouses w WHERE p.sku = $1 AND w.code = $2`, [sku, warehouse]);
  const row = rows[0];
  if (!row) throw new ApiError(422, "unknown_reference", `unknown sku/warehouse ${sku}/${warehouse}`);
  return { productId: Number(row.product_id), warehouseId: Number(row.warehouse_id) };
}

import type { Tx } from "../db.js";
import { ApiError } from "../errors.js";
import { money } from "../money.js";
import { resolveLocation } from "./inventory.js";
import { postEntry } from "./ledger.js";

export interface PoLineInput { sku: string; warehouse: string; qty: string; unitPrice: string }

export async function createPurchaseOrder(
  tx: Tx, input: { poNumber: string; supplierCode: string; lines: PoLineInput[]; actorId: number },
) {
  if (input.lines.length === 0) {
    throw new ApiError(422, "empty_order", "a purchase order needs at least one line");
  }
  const supplier = await tx.query<{ id: string }>(
    `SELECT id FROM suppliers WHERE code = $1 AND is_active`, [input.supplierCode]);
  if (!supplier.rows[0]) {
    throw new ApiError(422, "unknown_reference", `unknown supplier ${input.supplierCode}`);
  }

  // Resolve every sku/warehouse BEFORE writing anything. The first version
  // inserted lines with `INSERT ... SELECT FROM products, warehouses WHERE
  // sku = $1`, which silently inserts zero rows for an unknown sku -- a probe
  // produced a 201 purchase order with no lines and a total_amount of 50.00,
  // which would then approve and close with nothing outstanding.
  const resolved = [];
  for (const line of input.lines) {
    resolved.push({ line, loc: await resolveLocation(tx, line.sku, line.warehouse) });
  }

  // Exact decimal throughout: see src/money.ts. The float version of this
  // line lost a cent on values like 1.005 x 1.
  const total = money.sum(input.lines.map((l) => money.mul(l.qty, l.unitPrice, 2, "unit_price")));

  const po = await tx.query<{ id: string }>(
    `INSERT INTO purchase_orders (po_number, supplier_id, status, total_amount, created_by)
     VALUES ($1, $2, 'PENDING_APPROVAL', $3, $4) RETURNING id`,
    [input.poNumber, supplier.rows[0].id, total, input.actorId]);
  const poId = Number(po.rows[0]!.id);

  for (const { line, loc } of resolved) {
    const ins = await tx.query(
      `INSERT INTO purchase_order_lines (po_id, product_id, warehouse_id, ordered_qty, unit_price)
       VALUES ($1, $2, $3, $4, $5)`,
      [poId, loc.productId, loc.warehouseId, line.qty, line.unitPrice]);
    if (ins.rowCount !== 1) {
      throw new ApiError(500, "internal_error", "purchase order line was not written");
    }
  }
  return { purchase_order_id: poId, status: "PENDING_APPROVAL", total_amount: total };
}

/**
 * Approval snapshots the approver's limit onto the PO. po_maker_checker and
 * po_within_limit are CHECK constraints, so a service bug cannot approve your
 * own order or exceed your limit -- the write simply fails and the error mapper
 * turns it into a 403.
 */
export async function approvePurchaseOrder(tx: Tx, poId: number, actorId: number) {
  const limit = await tx.query<{ lim: string | null }>(
    `SELECT max(r.po_approval_limit)::text AS lim
       FROM user_roles ur JOIN roles r ON r.code = ur.role_code
      WHERE ur.user_id = $1`, [actorId]);

  const { rows } = await tx.query<{ id: string; status: string; approved_limit: string }>(
    `UPDATE purchase_orders
        SET status = 'APPROVED', approved_by = $2, approved_at = now(), approved_limit = $3
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING id, status, approved_limit::text`,
    [poId, actorId, limit.rows[0]?.lim ?? null]);

  if (!rows[0]) {
    throw new ApiError(409, "not_pending_approval",
      `purchase order ${poId} is not awaiting approval`);
  }
  return { purchase_order_id: rows[0].id, status: rows[0].status, approved_limit: rows[0].approved_limit };
}

export async function purchaseOrderStatus(tx: Tx, poId: number) {
  const po = await tx.query(
    `SELECT po.id::text, po.po_number, po.status, po.total_amount::text,
            po.created_by::text, po.approved_by::text, po.approved_at
       FROM purchase_orders po WHERE po.id = $1`, [poId]);
  if (!po.rows[0]) throw new ApiError(404, "not_found", `purchase order ${poId} not found`);

  const lines = await tx.query(
    `SELECT s.po_line_id::text, p.sku, w.code AS warehouse,
            s.ordered_qty::text, s.received_qty::text, s.outstanding_qty::text,
            s.is_over_received, s.unit_price::text
       FROM po_line_status s
       JOIN products p   ON p.id = s.product_id
       JOIN warehouses w ON w.id = s.warehouse_id
      WHERE s.po_id = $1 ORDER BY s.po_line_id`, [poId]);

  return { ...po.rows[0], lines: lines.rows };
}

export interface ReceiptLineInput {
  poLineId: number;
  receivedQty: string;
  /** Caller must ask for it AND hold receipt.over_receive; neither alone is enough. */
  allowOverReceipt?: boolean;
}

/**
 * What to do when a line would exceed its ordered quantity and the caller is
 * not authorised to accept it.
 *
 * `reject_batch` (the default) keeps the original all-or-nothing behaviour: a
 * lorry that arrived wrong is one event, and a warehouse clerk usually wants to
 * stop and look at it rather than half-book it.
 *
 * `reject_line` books the good lines and reports the bad ones. That is the
 * right shape for a multi-supplier consolidated delivery, where one wrong line
 * should not hold up nine correct ones.
 */
export type OverReceiptPolicy = "reject_batch" | "reject_line";

/**
 * Requirement 4. Over-receipt is decided here, in application code, under an
 * explicit row lock -- not left to the trigger, which stays as the backstop.
 *
 * Partial receipt needs no special case: outstanding_qty is derived from the
 * sum of receipts (po_line_status), so receiving 40 of 100 leaves 60
 * outstanding without any counter to keep in step.
 */
interface PoLineRow {
  id: string; product_id: string; warehouse_id: string;
  ordered_qty: string; unit_price: string; received: string;
}

export async function receiveGoods(
  tx: Tx,
  input: { poId: number; lines: ReceiptLineInput[]; actorId: number; mayOverReceive: boolean;
           onOverReceipt?: OverReceiptPolicy },
) {
  const po = await tx.query<{ status: string }>(
    `SELECT status FROM purchase_orders WHERE id = $1`, [input.poId]);
  if (!po.rows[0]) throw new ApiError(404, "not_found", `purchase order ${input.poId} not found`);
  if (!["APPROVED", "RECEIVING"].includes(po.rows[0].status)) {
    throw new ApiError(409, "not_receivable",
      `purchase order ${input.poId} is ${po.rows[0].status}; only an approved PO can be received`);
  }

  // Lock every PO line this receipt touches, in id order, in one statement.
  // LockRows sits above Sort, so two concurrent receipts over the same lines
  // queue rather than deadlock -- and neither can read a stale received total.
  const ids = input.lines.map((l) => l.poLineId).sort((a, b) => a - b);
  const locked = await tx.query<{
    id: string; product_id: string; warehouse_id: string;
    ordered_qty: string; unit_price: string; received: string;
  }>(
    `SELECT l.id, l.product_id, l.warehouse_id, l.ordered_qty::text, l.unit_price::text,
            COALESCE((SELECT SUM(g.received_qty) FROM goods_receipt_lines g
                       WHERE g.po_line_id = l.id), 0)::text AS received
       FROM purchase_order_lines l
      WHERE l.id = ANY($1::bigint[]) AND l.po_id = $2
      ORDER BY l.id
      FOR UPDATE OF l`, [ids, input.poId]);

  if (locked.rowCount !== ids.length) {
    throw new ApiError(422, "unknown_reference", "one or more PO lines do not belong to this PO");
  }
  const byId = new Map(locked.rows.map((r) => [Number(r.id), r]));

  // Classify every line before writing anything. Two policies share one pass:
  // reject_batch throws on the first offender (unchanged default), reject_line
  // records the refusal and carries on with the rest.
  const policy: OverReceiptPolicy = input.onOverReceipt ?? "reject_batch";
  const accepted: Array<{ line: ReceiptLineInput; po_line: PoLineRow; isOver: boolean }> = [];
  const refused: Array<{ po_line_id: number; reason: string; ordered: string;
                         already_received: string; attempted: string }> = [];

  for (const line of input.lines) {
    const po_line = byId.get(line.poLineId)!;
    const after = money.add(po_line.received, line.receivedQty, 4, "received_qty");
    const isOver = money.cmp(after, po_line.ordered_qty) > 0;
    const authorised = Boolean(line.allowOverReceipt) && input.mayOverReceive;

    if (isOver && !authorised) {
      const detail = {
        po_line_id: line.poLineId,
        ordered: po_line.ordered_qty,
        already_received: po_line.received,
        attempted: line.receivedQty,
        reason: line.allowOverReceipt
          ? "requires the receipt.over_receive permission"
          : "resubmit with allow_over_receipt to accept it as an over-receipt",
      };
      if (policy === "reject_batch") {
        throw new ApiError(422, "over_receipt",
          `over-receipt on PO line ${line.poLineId}`,
          { ...detail, hint: detail.reason });
      }
      refused.push(detail);
      continue;
    }
    accepted.push({ line, po_line, isOver });
  }

  // A receipt that books nothing is not a receipt. Refusing here rather than
  // writing an empty goods_receipts row keeps the retry semantics simple: the
  // transaction rolls back, the Idempotency-Key is released, and the caller can
  // resubmit a corrected batch.
  if (accepted.length === 0) {
    throw new ApiError(422, "over_receipt",
      "every line on this receipt was refused", { refused });
  }
  const planned = accepted;

  const receipt = await tx.query<{ id: string }>(
    `INSERT INTO goods_receipts (po_id, received_by) VALUES ($1, $2) RETURNING id`,
    [input.poId, input.actorId]);
  const receiptId = Number(receipt.rows[0]!.id);

  // One journal entry for the whole receipt: DR Inventory per line, CR GR-IR
  // for the total. The Inventory lines carry product+warehouse so the control
  // account ties per SKU, which is what movement_ties_to_ledger checks.
  const entryLines = planned.map(({ line, po_line }) => ({
    account: "1300",
    amount: money.mul(line.receivedQty, po_line.unit_price, 2, "received_qty"),
    productId: Number(po_line.product_id),
    warehouseId: Number(po_line.warehouse_id),
  }));
  const grossValue = money.sum(entryLines.map((l) => l.amount));

  const entryId = await postEntry(tx, {
    sourceDoc: "goods_receipt",
    sourceDocId: receiptId,
    memo: `Goods receipt ${receiptId} against PO ${input.poId}`,
    createdBy: input.actorId,
    lines: [...entryLines, { account: "2100", amount: money.neg(grossValue) }],
  });

  const out = [];
  for (const { line, po_line, isOver } of planned) {
    const movement = await tx.query<{ id: string }>(
      `INSERT INTO stock_movements
         (product_id, warehouse_id, qty_delta, unit_cost, movement_type,
          source_doc, source_doc_id, ledger_entry_id, created_by)
       VALUES ($1, $2, $3, $4, 'GOODS_RECEIPT', 'goods_receipt', $5, $6, $7)
       RETURNING id`,
      [po_line.product_id, po_line.warehouse_id, line.receivedQty, po_line.unit_price,
       receiptId, entryId, input.actorId]);

    await tx.query(
      `INSERT INTO goods_receipt_lines
         (goods_receipt_id, po_line_id, received_qty, stock_movement_id, over_receipt)
       VALUES ($1, $2, $3, $4, $5)`,
      [receiptId, line.poLineId, line.receivedQty, movement.rows[0]!.id, isOver]);

    const remaining = money.sub(
      money.sub(po_line.ordered_qty, po_line.received, 4), line.receivedQty, 4);
    out.push({
      po_line_id: line.poLineId,
      received_qty: line.receivedQty,
      outstanding_qty: remaining,
      over_receipt: isOver,
      stock_movement_id: movement.rows[0]!.id,
    });
  }

  // CLOSED only when nothing is outstanding anywhere on the PO.
  const still = await tx.query<{ open: string }>(
    `SELECT count(*)::text AS open FROM po_line_status
      WHERE po_id = $1 AND outstanding_qty > 0`, [input.poId]);
  await tx.query(
    `UPDATE purchase_orders SET status = $2 WHERE id = $1`,
    [input.poId, Number(still.rows[0]!.open) === 0 ? "CLOSED" : "RECEIVING"]);

  return {
    goods_receipt_id: receiptId,
    ledger_entry_id: entryId,
    // Only the accepted lines are in gross_value, and postEntry built the
    // entry from the same list, so the entry balances over exactly what was
    // booked -- a refused line contributes no movement and no ledger line.
    gross_value: grossValue,
    lines: out,
    refused,
    policy,
  };
}

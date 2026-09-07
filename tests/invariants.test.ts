import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool, withTx } from "../src/db.js";
import { postEntry } from "../src/modules/ledger.js";
import {
  type Api, call, freshProduct, makeSalesOrder, sql, startApi, stockUp, uniq,
} from "./helpers.js";

let api: Api;
before(async () => { api = await startApi(); });
after(async () => { await api.close(); await closePool(); });

/**
 * A coverage audit showed the README claimed "this stage only claims what a
 * test exercises" while several invariants had never been made to reject
 * anything. Every case below attempts a real violation and asserts the refusal,
 * so the claim is true rather than aspirational.
 */
const rejects = async (fn: () => Promise<unknown>, expect: { code?: string; constraint?: string }) =>
  assert.rejects(fn, (err: any) => {
    const got = err.constraint ?? err.code;
    const first = String(err.message).split("\n")[0] ?? "";
    console.log(`  [invariant] refused by ${got}: ${first.slice(0, 76)}`);
    if (expect.code) assert.equal(err.code, expect.code);
    if (expect.constraint) assert.equal(err.constraint, expect.constraint);
    return true;
  });

describe("invariants that had no negative test", () => {
  it("po_within_limit: a manager cannot approve beyond their limit", async () => {
    const sku = await freshProduct();
    const po = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
      po_number: uniq("PO"), supplier_code: "SUP-1",
      // manager's po_approval_limit is 50000.00
      lines: [{ sku, warehouse: "WH1", qty: "1000", unit_price: "72.00" }],
    });
    assert.equal(po.body.total_amount, "72000.00");
    const res = await call(api, "manager@nw.test", "POST",
      `/purchase-orders/${po.body.purchase_order_id}/approve`);
    console.log(`  [invariant] 72,000 on a 50,000 limit -> ${res.status} ${res.body.error}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "approval_limit_exceeded");
  });

  it("movement_ties_to_ledger: a movement cannot book a different value than its entry", async () => {
    const sku = await freshProduct();
    const loc = await sql(
      `SELECT p.id AS pid, w.id AS wid FROM products p, warehouses w
        WHERE p.sku = $1 AND w.code = 'WH1'`, [sku]);
    const { pid, wid } = loc.rows[0];
    await rejects(() => withTx(async (tx) => {
      const entry = await postEntry(tx, {
        sourceDoc: "goods_receipt", sourceDocId: 1, createdBy: 1,
        lines: [
          { account: "1300", amount: "99.00", productId: pid, warehouseId: wid },
          { account: "2100", amount: "-99.00" },
        ],
      });
      // The movement books 1 x 12.50 = 12.50, the entry posts 99.00.
      await tx.query(
        `INSERT INTO stock_movements (product_id, warehouse_id, qty_delta, unit_cost,
           movement_type, source_doc, source_doc_id, ledger_entry_id, created_by)
         VALUES ($1,$2,1,12.50,'GOODS_RECEIPT','goods_receipt',1,$3,1)`, [pid, wid, entry]);
    }), { code: "ERP07" });
  });

  it("reversal_mirrors_original: a reversal that is not an exact mirror is refused", async () => {
    const original = await withTx((tx) => postEntry(tx, {
      sourceDoc: "manual_journal", sourceDocId: 900, memo: "original", createdBy: 1,
      lines: [{ account: "5900", amount: "10.00" }, { account: "2000", amount: "-10.00" }],
    }));
    await rejects(() => withTx((tx) => postEntry(tx, {
      sourceDoc: "manual_journal", sourceDocId: 900, memo: "half a reversal",
      createdBy: 1, reversesId: original,
      lines: [{ account: "5900", amount: "-5.00" }, { account: "2000", amount: "5.00" }],
    })), { code: "ERP06" });
  });

  it("stock_balances_no_direct_write: the projection refuses a direct write", async () => {
    const sku = await freshProduct();
    await stockUp(api, sku, "5", "10.00");
    await rejects(() => sql(
      `UPDATE stock_balances SET reserved_qty = 0.5
         WHERE product_id = (SELECT id FROM products WHERE sku = $1)`, [sku]),
      { code: "ERP09" });
  });

  it("reservation_state_machine: a terminal reservation cannot be revived", async () => {
    const sku = await freshProduct();
    await stockUp(api, sku, "1", "10.00");
    const soId = await makeSalesOrder(api, sku, "1");
    await call(api, "sales@nw.test", "POST", `/sales-orders/${soId}/confirm`);
    await call(api, "ship@nw.test", "POST", `/sales-orders/${soId}/fulfil`);
    const res = await sql(
      `SELECT r.id FROM stock_reservations r
        JOIN sales_order_lines l ON l.id = r.sales_order_line_id
       WHERE l.so_id = $1 AND r.status = 'CONSUMED'`, [soId]);
    assert.equal(res.rowCount, 1, "the shipment should have consumed the hold");
    await rejects(() => sql(
      `UPDATE stock_reservations SET status = 'HELD' WHERE id = $1`, [res.rows[0].id]),
      { code: "ERP08" });
  });

  it("movement_sign_matches_type: a receipt cannot have a negative quantity", async () => {
    const sku = await freshProduct();
    const loc = await sql(
      `SELECT p.id AS pid, w.id AS wid FROM products p, warehouses w
        WHERE p.sku = $1 AND w.code = 'WH1'`, [sku]);
    const { pid, wid } = loc.rows[0];
    await rejects(() => withTx(async (tx) => {
      const entry = await postEntry(tx, {
        sourceDoc: "goods_receipt", sourceDocId: 2, createdBy: 1,
        lines: [
          { account: "1300", amount: "-12.50", productId: pid, warehouseId: wid },
          { account: "2100", amount: "12.50" },
        ],
      });
      await tx.query(
        `INSERT INTO stock_movements (product_id, warehouse_id, qty_delta, unit_cost,
           movement_type, source_doc, source_doc_id, ledger_entry_id, created_by)
         VALUES ($1,$2,-1,12.50,'GOODS_RECEIPT','goods_receipt',2,$3,1)`, [pid, wid, entry]);
    }), { constraint: "movement_sign_matches_type" });
  });

  it("po_frozen_after_approval: an approved PO's value cannot change", async () => {
    const sku = await freshProduct();
    const po = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
      po_number: uniq("PO"), supplier_code: "SUP-1",
      lines: [{ sku, warehouse: "WH1", qty: "10", unit_price: "10.00" }],
    });
    const id = po.body.purchase_order_id;
    await call(api, "manager@nw.test", "POST", `/purchase-orders/${id}/approve`);
    await rejects(() => sql(
      `UPDATE purchase_orders SET total_amount = 10000000000 WHERE id = $1`, [id]),
      { code: "ERP11" });
  });

  it("po_lines_frozen: lines cannot be added to an approved PO", async () => {
    const sku = await freshProduct();
    const other = await freshProduct();
    const po = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
      po_number: uniq("PO"), supplier_code: "SUP-1",
      lines: [{ sku, warehouse: "WH1", qty: "1", unit_price: "1.00" }],
    });
    const id = po.body.purchase_order_id;
    await call(api, "manager@nw.test", "POST", `/purchase-orders/${id}/approve`);
    await rejects(() => sql(
      `INSERT INTO purchase_order_lines (po_id, product_id, warehouse_id, ordered_qty, unit_price)
       SELECT $1, p.id, w.id, 5, 1.00 FROM products p, warehouses w
        WHERE p.sku = $2 AND w.code = 'WH1'`, [id, other]),
      { code: "ERP11" });
  });

  it("guard_ledger_line: nothing posts into a closed period", async () => {
    // Close last month, so closing it cannot disturb anything else in this run.
    const last = await sql(
      `INSERT INTO accounting_periods (period, status)
       VALUES ((date_trunc('month', current_date) - interval '1 month')::date, 'CLOSED')
       ON CONFLICT (period) DO UPDATE SET status = 'CLOSED'
       RETURNING period::text`);
    const period = last.rows[0].period;
    const res = await call(api, "acct@nw.test", "POST", "/ledger/entries", {
      memo: "backdated into a closed period", source_doc_id: 7, entry_date: period,
      lines: [{ account: "5900", amount: "1.00" }, { account: "2000", amount: "-1.00" }],
    });
    console.log(`  [invariant] posting into closed ${period} -> ${res.status} ${res.body.error}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "period_closed");
  });

  it("one_live_hold_per_line: a line cannot carry two live holds", async () => {
    const sku = await freshProduct();
    await stockUp(api, sku, "5", "10.00");
    const soId = await makeSalesOrder(api, sku, "2");
    await call(api, "sales@nw.test", "POST", `/sales-orders/${soId}/confirm`);
    const line = await sql(`SELECT id, product_id, warehouse_id FROM sales_order_lines WHERE so_id = $1`, [soId]);
    const l = line.rows[0];
    await rejects(() => sql(
      `INSERT INTO stock_reservations (sales_order_line_id, product_id, warehouse_id, qty, expires_at)
       VALUES ($1,$2,$3,1, now() + interval '10 min')`, [l.id, l.product_id, l.warehouse_id]),
      { constraint: "one_live_hold_per_line" });
  });

  it("stock_movements_append_only: a posted movement cannot be edited", async () => {
    const sku = await freshProduct();
    await stockUp(api, sku, "3", "10.00");
    const m = await sql(
      `SELECT m.id FROM stock_movements m JOIN products p ON p.id = m.product_id
        WHERE p.sku = $1`, [sku]);
    await rejects(() => sql(
      `UPDATE stock_movements SET qty_delta = 9999 WHERE id = $1`, [m.rows[0].id]),
      { code: "ERP02" });
  });

  it("res_expiry_sane: a reservation cannot be born already expired", async () => {
    const sku = await freshProduct();
    await stockUp(api, sku, "2", "10.00");
    const soId = await makeSalesOrder(api, sku, "1");
    const line = await sql(`SELECT id, product_id, warehouse_id FROM sales_order_lines WHERE so_id = $1`, [soId]);
    const l = line.rows[0];
    await rejects(() => sql(
      `INSERT INTO stock_reservations
         (sales_order_line_id, product_id, warehouse_id, qty, created_at, expires_at)
       VALUES ($1,$2,$3,1, now(), now() - interval '1 min')`,
      [l.id, l.product_id, l.warehouse_id]),
      { constraint: "res_expiry_sane" });
  });

  it("sol_not_over_fulfilled: fulfilled_qty cannot exceed the ordered qty", async () => {
    const sku = await freshProduct();
    const soId = await makeSalesOrder(api, sku, "3");
    await rejects(() => sql(
      `UPDATE sales_order_lines SET fulfilled_qty = 4 WHERE so_id = $1`, [soId]),
      { constraint: "sol_not_over_fulfilled" });
  });
});

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../src/db.js";
import { type Api, call, freshProduct, sql, startApi, uniq } from "./helpers.js";

let api: Api;
before(async () => { api = await startApi(); });
after(async () => { await api.close(); await closePool(); });

/** A PO with two lines: one that will fit, one that will over-receive. */
async function twoLinePo() {
  const good = await freshProduct();
  const bad = await freshProduct();
  const po = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
    po_number: uniq("PO"), supplier_code: "SUP-1",
    lines: [
      { sku: good, warehouse: "WH1", qty: "100", unit_price: "2.50" },
      { sku: bad,  warehouse: "WH1", qty: "10",  unit_price: "4.00" },
    ],
  });
  const id = po.body.purchase_order_id;
  await call(api, "manager@nw.test", "POST", `/purchase-orders/${id}/approve`);
  const d = await call(api, "agent@nw.test", "GET", `/purchase-orders/${id}`);
  const bySku = new Map(d.body.lines.map((l: any) => [l.sku, Number(l.po_line_id)]));
  return { id, good, bad, goodLine: bySku.get(good)!, badLine: bySku.get(bad)! };
}

const onHand = async (sku: string) => {
  const { rows } = await sql(
    `SELECT COALESCE(b.on_hand_qty,0)::text q FROM products p
       LEFT JOIN stock_balances b ON b.product_id = p.id WHERE p.sku=$1`, [sku]);
  return rows[0]?.q ?? "0";
};

describe("over-receipt: batch policy versus line policy", () => {
  it("reject_batch (default) refuses the whole receipt, exactly as before", async () => {
    const po = await twoLinePo();
    const res = await call(api, "wh@nw.test", "POST", `/purchase-orders/${po.id}/goods-receipts`, {
      lines: [
        { po_line_id: po.goodLine, received_qty: "40" },
        { po_line_id: po.badLine,  received_qty: "12" },
      ],
    });
    console.log(`  [batch] 40 good + 12 over -> ${res.status} ${res.body.error}`);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "over_receipt");
    assert.equal(await onHand(po.good), "0", "the good line was not booked either");
    const d = await call(api, "agent@nw.test", "GET", `/purchase-orders/${po.id}`);
    assert.equal(d.body.status, "APPROVED", "the PO never entered RECEIVING");
  });

  it("reject_line books the good line and reports the bad one", async () => {
    const po = await twoLinePo();
    const res = await call(api, "wh@nw.test", "POST", `/purchase-orders/${po.id}/goods-receipts`, {
      on_over_receipt: "reject_line",
      lines: [
        { po_line_id: po.goodLine, received_qty: "40" },
        { po_line_id: po.badLine,  received_qty: "12" },
      ],
    });
    console.log(`  [line] ${res.status} policy=${res.body.policy}`,
      `booked=${res.body.lines.length} refused=${res.body.refused.length}`,
      `gross=${res.body.gross_value}`);
    console.log(`  [line] refused: ${JSON.stringify(res.body.refused[0])}`);
    assert.equal(res.status, 201);
    assert.equal(res.body.policy, "reject_line");
    assert.equal(res.body.lines.length, 1);
    assert.equal(res.body.lines[0].po_line_id, po.goodLine);
    assert.equal(res.body.refused.length, 1);
    assert.equal(res.body.refused[0].po_line_id, po.badLine);
    assert.equal(res.body.refused[0].ordered, "10.0000");
    assert.equal(res.body.refused[0].attempted, "12");

    assert.equal(await onHand(po.good), "40.0000", "the good line was booked");
    assert.equal(await onHand(po.bad), "0", "the refused line moved no stock");
  });

  it("the entry balances over exactly the accepted lines", async () => {
    const po = await twoLinePo();
    const res = await call(api, "wh@nw.test", "POST", `/purchase-orders/${po.id}/goods-receipts`, {
      on_over_receipt: "reject_line",
      lines: [
        { po_line_id: po.goodLine, received_qty: "40" },
        { po_line_id: po.badLine,  received_qty: "12" },
      ],
    });
    const entry = res.body.ledger_entry_id;
    const lines = await sql(
      `SELECT account_code, amount::text, product_id FROM ledger_lines
        WHERE entry_id=$1 ORDER BY id`, [entry]);
    const total = await sql(`SELECT SUM(amount)::text s, count(*)::int n FROM ledger_lines
                              WHERE entry_id=$1`, [entry]);
    console.log(`  [entry ${entry}] ${lines.rows.map((r:any)=>`${r.account_code} ${r.amount}`).join(", ")}`,
      `| lines=${total.rows[0].n} sum=${total.rows[0].s}`);
    // 40 x 2.50 = 100.00 only. The refused line contributes nothing, so there
    // is no 1300 leg for it and the GR-IR credit is 100.00, not 148.00.
    assert.equal(res.body.gross_value, "100.00");
    assert.equal(Number(total.rows[0].s), 0, "still balances");
    assert.equal(total.rows[0].n, 2, "one Inventory leg plus one GR-IR leg");

    const rec = await call(api, "acct@nw.test", "GET", "/reports/inventory-reconciliation");
    console.log(`  [entry] reconciliation delta=${rec.body.delta} status=${rec.body.status}`);
    assert.equal(rec.body.status, "TIES");
  });

  it("if every line is refused, nothing is written at all", async () => {
    const po = await twoLinePo();
    const res = await call(api, "wh@nw.test", "POST", `/purchase-orders/${po.id}/goods-receipts`, {
      on_over_receipt: "reject_line",
      lines: [{ po_line_id: po.badLine, received_qty: "12" }],
    });
    console.log(`  [all-refused] ${res.status} ${res.body.error}, refused=${res.body.refused.length}`);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "over_receipt");
    const grs = await sql(`SELECT count(*)::int n FROM goods_receipts WHERE po_id=$1`, [po.id]);
    assert.equal(grs.rows[0].n, 0, "no empty goods_receipts row left behind");
  });

  it("an authorised over-receipt is still accepted under either policy", async () => {
    const po = await twoLinePo();
    const res = await call(api, "whsup@nw.test", "POST",
      `/purchase-orders/${po.id}/goods-receipts`, {
        on_over_receipt: "reject_line",
        lines: [{ po_line_id: po.badLine, received_qty: "12", allow_over_receipt: true }],
      });
    console.log(`  [authorised] ${res.status} over_receipt=${res.body.lines[0].over_receipt}`,
      `refused=${res.body.refused.length}`);
    assert.equal(res.status, 201);
    assert.equal(res.body.lines[0].over_receipt, true);
    assert.equal(res.body.refused.length, 0);
  });
});

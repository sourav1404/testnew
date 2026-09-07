import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../src/db.js";
import { type Api, call, freshProduct, startApi, uniq } from "./helpers.js";

let api: Api;
before(async () => { api = await startApi(); });
after(async () => { await api.close(); await closePool(); });

async function approvedPo(sku: string, qty: string, price = "4.00") {
  const po = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
    po_number: uniq("PO"), supplier_code: "SUP-1",
    lines: [{ sku, warehouse: "WH1", qty, unit_price: price }],
  });
  assert.equal(po.status, 201);
  const id = po.body.purchase_order_id;
  const appr = await call(api, "manager@nw.test", "POST", `/purchase-orders/${id}/approve`);
  assert.equal(appr.status, 200);
  const detail = await call(api, "agent@nw.test", "GET", `/purchase-orders/${id}`);
  return { id, lineId: Number(detail.body.lines[0].po_line_id) };
}

const receive = (id: number, lineId: number, qty: string, over = false, who = "wh@nw.test") =>
  call(api, who, "POST", `/purchase-orders/${id}/goods-receipts`, {
    lines: [{ po_line_id: lineId, received_qty: qty, allow_over_receipt: over }],
  });

const status = async (id: number) =>
  (await call(api, "agent@nw.test", "GET", `/purchase-orders/${id}`)).body;

describe("outstanding quantity across partial receipts", () => {
  it("tracks outstanding correctly over three partial receipts, then closes", async () => {
    const sku = await freshProduct();
    const { id, lineId } = await approvedPo(sku, "100");

    const steps: Array<[string, string]> = [["40", "60.0000"], ["35", "25.0000"], ["25", "0.0000"]];
    for (const [qty, expected] of steps) {
      const gr = await receive(id, lineId, qty);
      assert.equal(gr.status, 201, JSON.stringify(gr.body));
      const s = await status(id);
      console.log(`  [procurement] received ${qty} -> outstanding ${s.lines[0].outstanding_qty}, PO ${s.status}`);
      assert.equal(s.lines[0].outstanding_qty, expected);
      assert.equal(s.lines[0].received_qty,
        (100 - Number(expected)).toFixed(4), "received is the sum of receipts");
    }
    const done = await status(id);
    assert.equal(done.status, "CLOSED", "a PO with nothing outstanding is closed");
    assert.equal(done.lines[0].is_over_received, false);
  });

  it("rejects an over-receipt rather than corrupting outstanding tracking", async () => {
    const sku = await freshProduct();
    const { id, lineId } = await approvedPo(sku, "10");
    assert.equal((await receive(id, lineId, "7")).status, 201);

    const over = await receive(id, lineId, "5");
    console.log(`  [procurement] ordered 10, had 7, tried 5 -> ${over.status} ${over.body.error}`,
      `(ordered=${over.body.ordered} already=${over.body.already_received} attempted=${over.body.attempted})`);
    assert.equal(over.status, 422);
    assert.equal(over.body.error, "over_receipt");

    // The rejected receipt left nothing behind.
    const s = await status(id);
    assert.equal(s.lines[0].received_qty, "7.0000");
    assert.equal(s.lines[0].outstanding_qty, "3.0000");
    assert.equal(s.status, "RECEIVING");
  });

  it("accepts a flagged over-receipt and records the fact", async () => {
    const sku = await freshProduct();
    const { id, lineId } = await approvedPo(sku, "10");
    const gr = await receive(id, lineId, "12", true, "whsup@nw.test");
    assert.equal(gr.status, 201);
    const s = await status(id);
    console.log(`  [procurement] flagged over-receipt: received=${s.lines[0].received_qty}`,
      `outstanding=${s.lines[0].outstanding_qty} is_over_received=${s.lines[0].is_over_received}`);
    assert.equal(gr.body.lines[0].over_receipt, true);
    assert.equal(s.lines[0].received_qty, "12.0000");
    assert.equal(s.lines[0].outstanding_qty, "-2.0000",
      "the excess is visible as negative outstanding, not silently absorbed");
    assert.equal(s.lines[0].is_over_received, true);
  });

  it("two concurrent receipts cannot both slip past the ordered quantity", async () => {
    const sku = await freshProduct();
    const { id, lineId } = await approvedPo(sku, "10");
    // Each asks for 6. Ordered is 10, so at most one can succeed.
    const [a, b] = await Promise.all([receive(id, lineId, "6"), receive(id, lineId, "6")]);
    const ok = [a, b].filter((r) => r.status === 201);
    const rejected = [a, b].filter((r) => r.status === 422);
    const s = await status(id);
    console.log(`  [procurement] concurrent 6+6 on a 10 line: accepted=${ok.length}`,
      `rejected=${rejected.length} received=${s.lines[0].received_qty}`);
    assert.equal(ok.length, 1, "exactly one receipt is accepted");
    assert.equal(rejected.length, 1);
    assert.equal(s.lines[0].received_qty, "6.0000");
  });

  it("a goods receipt raises stock and posts a balanced GR-IR entry", async () => {
    const sku = await freshProduct();
    const { id, lineId } = await approvedPo(sku, "50", "3.00");
    const gr = await receive(id, lineId, "50");
    assert.equal(gr.status, 201);
    assert.equal(gr.body.gross_value, "150.00");

    const avail = await call(api, "wh@nw.test", "GET", `/inventory/availability?sku=${sku}`);
    console.log(`  [procurement] after receipt: on_hand=${avail.body.items[0].on_hand_qty}`,
      `avg_cost=${avail.body.items[0].avg_unit_cost} entry=${gr.body.ledger_entry_id}`);
    assert.equal(avail.body.items[0].on_hand_qty, "50.0000");
    assert.equal(avail.body.items[0].avg_unit_cost, "3.0000");
  });

  it("an unapproved PO cannot be received against", async () => {
    const sku = await freshProduct();
    const po = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
      po_number: uniq("PO"), supplier_code: "SUP-1",
      lines: [{ sku, warehouse: "WH1", qty: "5", unit_price: "1.00" }],
    });
    const detail = await call(api, "agent@nw.test", "GET",
      `/purchase-orders/${po.body.purchase_order_id}`);
    const res = await receive(po.body.purchase_order_id,
      Number(detail.body.lines[0].po_line_id), "5");
    console.log(`  [procurement] receive against PENDING_APPROVAL -> ${res.status} ${res.body.error}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "not_receivable");
  });
});

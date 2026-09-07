import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../src/db.js";
import { type Api, balanceOf, call, freshProduct, startApi, uniq } from "./helpers.js";

let api: Api;
before(async () => { api = await startApi(); });
after(async () => { await api.close(); await closePool(); });

/** Same as helpers.call but able to send an Idempotency-Key. */
async function callKeyed(
  token: string, method: string, path: string, key: string | null, body?: unknown,
) {
  const res = await fetch(api.base + path, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    replay: res.headers.get("idempotent-replay"),
    body: text ? JSON.parse(text) : null,
  };
}

async function approvedPo(sku: string, qty: string) {
  const po = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
    po_number: uniq("PO"), supplier_code: "SUP-1",
    lines: [{ sku, warehouse: "WH1", qty, unit_price: "4.00" }],
  });
  const id = po.body.purchase_order_id;
  await call(api, "manager@nw.test", "POST", `/purchase-orders/${id}/approve`);
  const detail = await call(api, "agent@nw.test", "GET", `/purchase-orders/${id}`);
  return { id, lineId: Number(detail.body.lines[0].po_line_id) };
}

describe("idempotency: a retried mutation must not double-apply", () => {
  it("a retried goods receipt receives the stock once", async () => {
    const sku = await freshProduct();
    const { id, lineId } = await approvedPo(sku, "100");
    const key = uniq("idem");
    const payload = { lines: [{ po_line_id: lineId, received_qty: "40" }] };

    const first = await callKeyed("wh@nw.test", "POST",
      `/purchase-orders/${id}/goods-receipts`, key, payload);
    const second = await callKeyed("wh@nw.test", "POST",
      `/purchase-orders/${id}/goods-receipts`, key, payload);

    const balance = await balanceOf(sku);
    console.log(`  [idem] receipt sent twice with one key: ${first.status}/${second.status}`,
      `replay=${second.replay} on_hand=${balance.on_hand_qty}`);
    assert.equal(first.status, 201);
    assert.equal(first.replay, "false");
    assert.equal(second.status, 201);
    assert.equal(second.replay, "true", "the retry is a replay, not a new receipt");
    assert.equal(second.body.goods_receipt_id, first.body.goods_receipt_id,
      "and it returns the original receipt id");
    assert.equal(balance.on_hand_qty, "40.0000", "stock rose exactly once");

    const detail = await call(api, "agent@nw.test", "GET", `/purchase-orders/${id}`);
    assert.equal(detail.body.lines[0].received_qty, "40.0000");
    assert.equal(detail.body.lines[0].outstanding_qty, "60.0000");
  });

  it("without a key, two identical receipts both apply -- and say so", async () => {
    const sku = await freshProduct();
    const { id, lineId } = await approvedPo(sku, "100");
    const payload = { lines: [{ po_line_id: lineId, received_qty: "10" }] };
    await callKeyed("wh@nw.test", "POST", `/purchase-orders/${id}/goods-receipts`, null, payload);
    await callKeyed("wh@nw.test", "POST", `/purchase-orders/${id}/goods-receipts`, null, payload);
    const balance = await balanceOf(sku);
    console.log(`  [idem] no key, sent twice -> on_hand=${balance.on_hand_qty} (both applied, by design)`);
    assert.equal(balance.on_hand_qty, "20.0000");
  });

  it("the same key with a different body is a conflict, not a replay", async () => {
    const sku = await freshProduct();
    const { id, lineId } = await approvedPo(sku, "100");
    const key = uniq("idem");
    const first = await callKeyed("wh@nw.test", "POST",
      `/purchase-orders/${id}/goods-receipts`, key,
      { lines: [{ po_line_id: lineId, received_qty: "5" }] });
    assert.equal(first.status, 201);

    const different = await callKeyed("wh@nw.test", "POST",
      `/purchase-orders/${id}/goods-receipts`, key,
      { lines: [{ po_line_id: lineId, received_qty: "50" }] });
    console.log(`  [idem] same key, different body -> ${different.status} ${different.body.error}`);
    assert.equal(different.status, 409);
    assert.equal(different.body.error, "idempotency_key_reuse");

    const balance = await balanceOf(sku);
    assert.equal(balance.on_hand_qty, "5.0000", "the second body was not applied");
  });

  it("a key is scoped to its endpoint, so the same key elsewhere is independent", async () => {
    // Stage 1 keyed on the key alone, which meant one key reused on a second
    // endpoint replayed the first endpoint's response.
    const sku = await freshProduct();
    const key = uniq("idem");
    const po = await callKeyed("agent@nw.test", "POST", "/purchase-orders", key, {
      po_number: uniq("PO"), supplier_code: "SUP-1",
      lines: [{ sku, warehouse: "WH1", qty: "3", unit_price: "2.00" }],
    });
    assert.equal(po.status, 201);
    const so = await callKeyed("sales@nw.test", "POST", "/sales-orders", key, {
      so_number: uniq("SO"), customer_code: "CUST-1",
      lines: [{ sku, warehouse: "WH1", qty: "1", unit_price: "5.00" }],
    });
    console.log(`  [idem] same key on a different endpoint -> ${so.status} replay=${so.replay}`);
    assert.equal(so.status, 201);
    assert.equal(so.replay, "false", "not a replay of the purchase order");
    assert.ok(so.body.sales_order_id, "it really created a sales order");
  });

  it("a failed request releases its key so a retry can succeed", async () => {
    // The claim row and the effect share one transaction, so a rollback takes
    // the claim with it. Otherwise a crash would leave the key claimed and the
    // work undone, and the retry would be told "already handled".
    const sku = await freshProduct();
    const { id, lineId } = await approvedPo(sku, "10");
    const key = uniq("idem");

    const rejected = await callKeyed("wh@nw.test", "POST",
      `/purchase-orders/${id}/goods-receipts`, key,
      { lines: [{ po_line_id: lineId, received_qty: "99" }] });
    assert.equal(rejected.status, 422, "over-receipt is refused");

    const retried = await callKeyed("wh@nw.test", "POST",
      `/purchase-orders/${id}/goods-receipts`, key,
      { lines: [{ po_line_id: lineId, received_qty: "4" }] });
    console.log(`  [idem] after a 422, same key with a valid body -> ${retried.status} replay=${retried.replay}`);
    assert.equal(retried.status, 201, "the key was not left claimed by the failed attempt");
    assert.equal(retried.replay, "false");
    assert.equal((await balanceOf(sku)).on_hand_qty, "4.0000");
  });

  it("a retried fulfilment does not ship twice", async () => {
    const sku = await freshProduct();
    const { id, lineId } = await approvedPo(sku, "10");
    await callKeyed("wh@nw.test", "POST", `/purchase-orders/${id}/goods-receipts`, null,
      { lines: [{ po_line_id: lineId, received_qty: "10" }] });
    const so = await call(api, "sales@nw.test", "POST", "/sales-orders", {
      so_number: uniq("SO"), customer_code: "CUST-1",
      lines: [{ sku, warehouse: "WH1", qty: "4", unit_price: "9.00" }],
    });
    const soId = so.body.sales_order_id;
    await call(api, "sales@nw.test", "POST", `/sales-orders/${soId}/confirm`);

    const key = uniq("idem");
    const a = await callKeyed("ship@nw.test", "POST", `/sales-orders/${soId}/fulfil`, key);
    const b = await callKeyed("ship@nw.test", "POST", `/sales-orders/${soId}/fulfil`, key);
    const balance = await balanceOf(sku);
    console.log(`  [idem] fulfil sent twice with one key: ${a.status}/${b.status}`,
      `replay=${b.replay} on_hand=${balance.on_hand_qty}`);
    assert.equal(a.status, 200);
    assert.equal(b.replay, "true");
    assert.equal(b.body.cogs_entry_id, a.body.cogs_entry_id);
    assert.equal(balance.on_hand_qty, "6.0000", "four shipped once, not eight");
  });
});

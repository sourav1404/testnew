import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../src/db.js";
import { type Api, call, startApi, uniq } from "./helpers.js";

let api: Api;
before(async () => { api = await startApi(); });
after(async () => { await api.close(); await closePool(); });

/**
 * Every case here was a real defect found by probing the running API, not a
 * hypothetical. Three of them returned 201 or 500 before the fix.
 */
describe("input validation at the API boundary", () => {
  it("refuses a purchase order naming an unknown SKU instead of writing a phantom total", async () => {
    const res = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
      po_number: uniq("PO"), supplier_code: "SUP-1",
      lines: [{ sku: "DOES-NOT-EXIST", warehouse: "WH1", qty: "10", unit_price: "5.00" }],
    });
    console.log(`  [validation] unknown sku on a PO -> ${res.status} ${res.body.error}`);
    // Before the fix: 201, zero lines, total_amount 50.00, approvable, and it
    // would close with nothing outstanding.
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "unknown_reference");
  });

  it("refuses a sales order naming an unknown warehouse", async () => {
    const res = await call(api, "sales@nw.test", "POST", "/sales-orders", {
      so_number: uniq("SO"), customer_code: "CUST-1",
      lines: [{ sku: "SKU-001", warehouse: "NOPE", qty: "1", unit_price: "9.00" }],
    });
    console.log(`  [validation] unknown warehouse on an SO -> ${res.status} ${res.body.error}`);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "unknown_reference");
  });

  it("refuses an order with no lines, on both sides", async () => {
    const po = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
      po_number: uniq("PO"), supplier_code: "SUP-1", lines: [],
    });
    const so = await call(api, "sales@nw.test", "POST", "/sales-orders", {
      so_number: uniq("SO"), customer_code: "CUST-1", lines: [],
    });
    console.log(`  [validation] empty PO -> ${po.status} ${po.body.error}; empty SO -> ${so.status} ${so.body.error}`);
    assert.equal(po.status, 422);
    assert.equal(po.body.error, "empty_order");
    // The sales side used to accept this and then report CONFIRMED with no lines.
    assert.equal(so.status, 422);
    assert.equal(so.body.error, "empty_order");
  });

  for (const qty of ["-5", "0"]) {
    it(`rejects qty ${qty} with a client error, not a 500`, async () => {
      const res = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
        po_number: uniq("PO"), supplier_code: "SUP-1",
        lines: [{ sku: "SKU-001", warehouse: "WH1", qty, unit_price: "5.00" }],
      });
      console.log(`  [validation] qty=${qty} -> ${res.status} ${res.body.error} (${res.body.constraint})`);
      // Before the generic class-23 fallback these were 500 internal_error.
      assert.equal(res.status, 422);
      assert.equal(res.body.error, "constraint_violation");
      assert.equal(res.body.constraint, "purchase_order_lines_ordered_qty_check");
    });
  }

  for (const [label, price] of [["non-numeric", "abc"], ["overflow", "1e400"]] as const) {
    it(`rejects ${label} money with 400, not a 500`, async () => {
      const res = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
        po_number: uniq("PO"), supplier_code: "SUP-1",
        lines: [{ sku: "SKU-001", warehouse: "WH1", qty: "1", unit_price: price }],
      });
      console.log(`  [validation] unit_price=${price} -> ${res.status} ${res.body.error}`);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "bad_request");
    });
  }

  it("parameterises input: an injection-shaped value is data, not SQL", async () => {
    const res = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
      po_number: uniq("PO"), supplier_code: "SUP-1",
      lines: [{ sku: "SKU-001", warehouse: "WH1", qty: "1",
                unit_price: "'; DROP TABLE users; --" }],
    });
    assert.equal(res.status, 400);
    // The point of the test: the table it tried to drop is still there.
    const who = await call(api, "agent@nw.test", "GET", "/whoami");
    console.log(`  [validation] after injection attempt, /whoami -> ${who.status} (users table intact)`);
    assert.equal(who.status, 200);
    assert.equal(who.body.email, "agent@nw.test");
  });

  it("requires a known supplier and customer", async () => {
    const po = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
      po_number: uniq("PO"), supplier_code: "NO-SUCH-SUPPLIER",
      lines: [{ sku: "SKU-001", warehouse: "WH1", qty: "1", unit_price: "1.00" }],
    });
    const so = await call(api, "sales@nw.test", "POST", "/sales-orders", {
      so_number: uniq("SO"), customer_code: "NO-SUCH-CUSTOMER",
      lines: [{ sku: "SKU-001", warehouse: "WH1", qty: "1", unit_price: "1.00" }],
    });
    assert.equal(po.status, 422);
    assert.equal(so.status, 422);
  });

  it("rejects a malformed path parameter with 400", async () => {
    const res = await call(api, "manager@nw.test", "POST", "/purchase-orders/not-a-number/approve");
    console.log(`  [validation] /purchase-orders/not-a-number/approve -> ${res.status} ${res.body.error}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "bad_request");
  });
});

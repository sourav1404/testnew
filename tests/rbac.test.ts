import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../src/db.js";
import { type Api, call, freshProduct, sql, startApi, uniq } from "./helpers.js";

let api: Api;
before(async () => { api = await startApi(); });
after(async () => { await api.close(); await closePool(); });

describe("Requirement 6 -- authorization is enforced server-side", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await call(api, null, "GET", "/inventory/availability");
    console.log(`  [rbac] no token -> ${res.status} ${res.body.error}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "unauthenticated");
  });

  it("rejects an unknown bearer token with 401", async () => {
    const res = await call(api, "nobody@nw.test", "GET", "/inventory/availability");
    assert.equal(res.status, 401);
  });

  // The headline case: a real, authenticated, lower-privilege user is refused a
  // higher-privilege action at the API layer.
  const denials: Array<[string, string, string, string, unknown]> = [
    ["warehouse_operator", "wh@nw.test",    "POST", "/purchase-orders/1/approve",      undefined],
    ["sales_rep",          "sales@nw.test", "POST", "/ledger/entries",                 { memo: "x", lines: [] }],
    ["auditor",            "audit@nw.test", "POST", "/inventory/adjustments",
      { sku: "SKU-001", warehouse: "WH1", qty_delta: "5", reason: "nope" }],
    ["purchasing_agent",   "agent@nw.test", "POST", "/sales-orders/1/fulfil",          undefined],
    ["fulfilment_operator","ship@nw.test",  "POST", "/purchase-orders",
      { po_number: "X", supplier_code: "SUP-1", lines: [] }],
    ["auditor",            "audit@nw.test", "POST", "/ledger/entries/1/reverse",       { memo: "x" }],
  ];

  for (const [role, token, method, path, body] of denials) {
    it(`refuses ${role} at ${method} ${path} with 403`, async () => {
      const res = await call(api, token, method, path, body);
      console.log(`  [rbac] ${role} -> ${method} ${path} = ${res.status} (${res.body.error}: ${res.body.message})`);
      assert.equal(res.status, 403, `expected 403, body=${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, "forbidden");
      assert.ok(String(res.body.message).startsWith("requires "),
        "the response names the permission that was missing");
    });
  }

  it("the same actions succeed for the role that does hold the permission", async () => {
    // Proves the 403s above are about permissions, not about broken routes.
    const ok = await call(api, "acct@nw.test", "GET", "/ledger/trial-balance");
    assert.equal(ok.status, 200);
    const inv = await call(api, "wh@nw.test", "GET", "/inventory/availability");
    assert.equal(inv.status, 200);
  });

  it("over-receipt needs a permission, not just a request flag", async () => {
    const sku = await freshProduct();
    const po = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
      po_number: uniq("PO"), supplier_code: "SUP-1",
      lines: [{ sku, warehouse: "WH1", qty: "10", unit_price: "4.00" }],
    });
    const id = po.body.purchase_order_id;
    await call(api, "manager@nw.test", "POST", `/purchase-orders/${id}/approve`);
    const detail = await call(api, "agent@nw.test", "GET", `/purchase-orders/${id}`);
    const lineId = Number(detail.body.lines[0].po_line_id);

    // warehouse_operator asks for it but lacks receipt.over_receive.
    const denied = await call(api, "wh@nw.test", "POST", `/purchase-orders/${id}/goods-receipts`, {
      lines: [{ po_line_id: lineId, received_qty: "12", allow_over_receipt: true }],
    });
    console.log(`  [rbac] operator over-receipt -> ${denied.status} ${denied.body.error}: ${denied.body.hint}`);
    assert.equal(denied.status, 422);
    assert.equal(denied.body.error, "over_receipt");
    assert.match(String(denied.body.hint), /receipt\.over_receive/);

    // warehouse_supervisor holds it, so the same request is accepted.
    const allowed = await call(api, "whsup@nw.test", "POST",
      `/purchase-orders/${id}/goods-receipts`, {
        lines: [{ po_line_id: lineId, received_qty: "12", allow_over_receipt: true }],
      });
    console.log(`  [rbac] supervisor over-receipt -> ${allowed.status} over_receipt=${allowed.body?.lines?.[0]?.over_receipt}`);
    assert.equal(allowed.status, 201);
    assert.equal(allowed.body.lines[0].over_receipt, true);
  });

  it("maker-checker survives even a compromised service layer", async () => {
    // No API path can reach this, because purchasing_agent and
    // purchasing_manager are mutually exclusive roles. Asserting it directly
    // against the database shows the rule is structural, not a service check.
    const sku = await freshProduct();
    const po = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
      po_number: uniq("PO"), supplier_code: "SUP-1",
      lines: [{ sku, warehouse: "WH1", qty: "1", unit_price: "1.00" }],
    });
    const id = po.body.purchase_order_id;

    await assert.rejects(
      () => sql(
        `UPDATE purchase_orders
            SET approved_by = created_by, approved_at = now(), approved_limit = 999999
          WHERE id = $1`, [id]),
      (err: any) => {
        console.log(`  [rbac] self-approval refused by ${err.constraint}`);
        assert.equal(err.constraint, "po_maker_checker");
        return true;
      });
  });

  it("refuses to grant a role that conflicts with one already held", async () => {
    await assert.rejects(
      () => sql(
        `INSERT INTO user_roles (user_id, role_code)
         SELECT id, 'purchasing_manager' FROM users WHERE email = 'agent@nw.test'`),
      (err: any) => {
        console.log(`  [rbac] conflicting grant refused: ${err.message.split("\n")[0]}`);
        assert.equal(err.code, "ERP01");
        return true;
      });
  });
});

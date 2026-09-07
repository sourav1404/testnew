import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../src/db.js";
import { money } from "../src/money.js";
import { type Api, call, freshProduct, makeSalesOrder, sql, startApi, stockUp, uniq } from "./helpers.js";

let api: Api;
before(async () => { api = await startApi(); });
after(async () => { await api.close(); await closePool(); });

describe("money is exact, not float", () => {
  // db.ts keeps money as strings because "a float would silently lose the cent
  // that this whole system exists to keep track of" -- and the service layer
  // was then doing the arithmetic in float anyway.
  const cases: Array<[string, string, string, string]> = [
    ["1.005", "1",   "1.01", "float toFixed(2) gives 1.00"],
    ["0.1",   "3",   "0.30", "float gives 0.30000000000000004"],
    ["0.07",  "100", "7.00", "float gives 7.000000000000001"],
    ["2.675", "1",   "2.68", "float toFixed(2) gives 2.67"],
    ["12",    "7.50","90.00", "the over-receipt case"],
  ];
  for (const [a, b, want, why] of cases) {
    it(`${a} x ${b} = ${want} (${why})`, () => {
      assert.equal(money.mul(a, b), want);
    });
  }

  it("rounds half away from zero in both directions, as Postgres does", () => {
    assert.equal(money.mul("-1.005", "1"), "-1.01");
    assert.equal(money.mul("1.005", "1"), "1.01");
  });

  it("refuses a value with more precision than it can carry", () => {
    assert.throws(() => money.mul("1.123456789", "1"), /decimal places/);
  });

  it("a purchase order total is exact end to end", async () => {
    const sku = await freshProduct();
    const po = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
      po_number: uniq("PO"), supplier_code: "SUP-1",
      lines: [{ sku, warehouse: "WH1", qty: "1", unit_price: "1.005" }],
    });
    console.log(`  [precision] 1 x 1.005 -> total_amount ${po.body.total_amount}`,
      `(float path produced ${(1 * 1.005).toFixed(2)})`);
    assert.equal(po.status, 201);
    assert.equal(po.body.total_amount, "1.01");
  });

  it("a shipment's COGS and revenue are exact and the entry still balances", async () => {
    const sku = await freshProduct();
    await stockUp(api, sku, "3", "0.07");
    const soId = await makeSalesOrder(api, sku, "3", "1.005");
    await call(api, "sales@nw.test", "POST", `/sales-orders/${soId}/confirm`);
    const ship = await call(api, "ship@nw.test", "POST", `/sales-orders/${soId}/fulfil`);
    console.log(`  [precision] 3 @ 0.07 cost, 3 @ 1.005 price ->`,
      `cogs=${ship.body.cogs_total} revenue=${ship.body.revenue_total}`);
    assert.equal(ship.status, 200);
    assert.equal(ship.body.cogs_total, "0.21");
    assert.equal(ship.body.revenue_total, "3.02");   // 3 x 1.005 = 3.015 -> 3.02
    for (const entry of [ship.body.cogs_entry_id, ship.body.revenue_entry_id]) {
      const b = await sql(`SELECT SUM(amount)::text s FROM ledger_lines WHERE entry_id=$1`, [entry]);
      assert.equal(Number(b.rows[0].s), 0, `entry ${entry} must balance`);
    }
    const rec = await call(api, "acct@nw.test", "GET", "/reports/inventory-reconciliation");
    assert.equal(rec.body.status, "TIES");
  });
});

describe("confirming a sales order leaves an audit trail", () => {
  it("records who confirmed it and when", async () => {
    const sku = await freshProduct();
    await stockUp(api, sku, "2", "10.00");
    const soId = await makeSalesOrder(api, sku, "1");
    const res = await call(api, "sales@nw.test", "POST", `/sales-orders/${soId}/confirm`);
    const row = await sql(
      `SELECT u.email, so.confirmed_at IS NOT NULL AS stamped, so.status
         FROM sales_orders so JOIN users u ON u.id = so.confirmed_by WHERE so.id=$1`, [soId]);
    console.log(`  [audit] SO ${soId} confirmed_by=${row.rows[0]?.email}`,
      `confirmed_at set=${row.rows[0]?.stamped} status=${row.rows[0]?.status}`);
    // The actorId used to be discarded with `void actorId`.
    const me = await sql(`SELECT id FROM users WHERE email='sales@nw.test'`);
    assert.equal(res.body.confirmed_by, Number(me.rows[0].id),
      "the response names the confirming actor");
    assert.equal(row.rows[0].email, "sales@nw.test");
    assert.equal(row.rows[0].stamped, true);
  });

  it("the database refuses a confirmed order with no confirming actor", async () => {
    const sku = await freshProduct();
    const soId = await makeSalesOrder(api, sku, "1");
    await assert.rejects(
      () => sql(`UPDATE sales_orders SET status='CONFIRMED' WHERE id=$1`, [soId]),
      (err: any) => {
        console.log(`  [audit] bare status flip refused by ${err.constraint}`);
        assert.equal(err.constraint, "so_confirmed_has_actor");
        return true;
      });
  });
});

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../src/db.js";
import {
  type Api, balanceOf, call, freshProduct, makeSalesOrder, sql, startApi, stockUp,
} from "./helpers.js";

let api: Api;
before(async () => { api = await startApi(); });
after(async () => { await api.close(); await closePool(); });

const soStatus = async (id: number) =>
  (await call(api, "sales@nw.test", "GET", `/sales-orders/${id}`)).body;

describe("Requirement 5 -- partial fulfilment and backorder", () => {
  it("ships what exists and backorders the rest, then completes on restock", async () => {
    const sku = await freshProduct();
    await stockUp(api, sku, "5", "10.00");
    const soId = await makeSalesOrder(api, sku, "8", "25.00");

    const confirm = await call(api, "sales@nw.test", "POST", `/sales-orders/${soId}/confirm`);
    console.log(`  [fulfil] order 8 against 5 on hand -> reserved=${confirm.body.lines[0].reserved}`,
      `backordered=${confirm.body.lines[0].backordered}`);
    assert.equal(confirm.status, 200);
    assert.equal(confirm.body.lines[0].reserved, "5.0000");
    assert.equal(confirm.body.lines[0].backordered, "3.0000");

    const ship1 = await call(api, "ship@nw.test", "POST", `/sales-orders/${soId}/fulfil`);
    assert.equal(ship1.status, 200);
    const after1 = await soStatus(soId);
    console.log(`  [fulfil] first shipment: status=${ship1.body.status}`,
      `shipped=${ship1.body.lines[0].shipped} cogs=${ship1.body.cogs_total}`,
      `backordered=${after1.lines[0].backordered_qty} line=${after1.lines[0].line_status}`);
    assert.equal(ship1.body.status, "PARTIALLY_FULFILLED");
    assert.equal(ship1.body.lines[0].shipped, "5.0000");
    assert.equal(ship1.body.cogs_total, "50.00");
    assert.equal(ship1.body.revenue_total, "125.00");
    assert.equal(after1.lines[0].fulfilled_qty, "5.0000");
    assert.equal(after1.lines[0].backordered_qty, "3.0000");
    assert.equal(after1.lines[0].line_status, "BACKORDERED");

    const balance1 = await balanceOf(sku);
    assert.equal(balance1.on_hand_qty, "0.0000");
    assert.equal(balance1.reserved_qty, "0.0000", "the consumed hold is released");

    // Restock the backordered remainder at a different cost, so the moving
    // average is exercised rather than assumed.
    await stockUp(api, sku, "3", "20.00");
    const confirm2 = await call(api, "sales@nw.test", "POST", `/sales-orders/${soId}/confirm`);
    console.log(`  [fulfil] after restock -> reserved=${confirm2.body.lines[0].reserved}`,
      `backordered=${confirm2.body.lines[0].backordered}`);
    assert.equal(confirm2.body.lines[0].reserved, "3.0000");
    assert.equal(confirm2.body.lines[0].backordered, "0.0000");

    const ship2 = await call(api, "ship@nw.test", "POST", `/sales-orders/${soId}/fulfil`);
    const after2 = await soStatus(soId);
    console.log(`  [fulfil] second shipment: status=${ship2.body.status}`,
      `shipped=${ship2.body.lines[0].shipped} unit_cost=${ship2.body.lines[0].unit_cost}`,
      `line=${after2.lines[0].line_status}`);
    assert.equal(ship2.body.status, "FULFILLED");
    assert.equal(ship2.body.lines[0].shipped, "3.0000");
    assert.equal(ship2.body.lines[0].unit_cost, "20.0000",
      "the second shipment is valued at the new average, not the first cost");
    assert.equal(after2.lines[0].fulfilled_qty, "8.0000");
    assert.equal(after2.lines[0].backordered_qty, "0.0000");
    assert.equal(after2.lines[0].line_status, "FULFILLED");
  });

  it("a fully backordered line reserves nothing and refuses to ship", async () => {
    const sku = await freshProduct();
    const soId = await makeSalesOrder(api, sku, "4");
    const confirm = await call(api, "sales@nw.test", "POST", `/sales-orders/${soId}/confirm`);
    assert.equal(confirm.body.lines[0].reserved, "0.0000");
    assert.equal(confirm.body.lines[0].backordered, "4.0000");

    const ship = await call(api, "ship@nw.test", "POST", `/sales-orders/${soId}/fulfil`);
    console.log(`  [fulfil] nothing reserved -> ${ship.status} ${ship.body.error}`);
    assert.equal(ship.status, 409);
    assert.equal(ship.body.error, "nothing_to_ship");
  });

  it("cannot be over-fulfilled by shipping twice", async () => {
    const sku = await freshProduct();
    await stockUp(api, sku, "2", "10.00");
    const soId = await makeSalesOrder(api, sku, "2");
    await call(api, "sales@nw.test", "POST", `/sales-orders/${soId}/confirm`);
    assert.equal((await call(api, "ship@nw.test", "POST", `/sales-orders/${soId}/fulfil`)).status, 200);

    const again = await call(api, "ship@nw.test", "POST", `/sales-orders/${soId}/fulfil`);
    console.log(`  [fulfil] second ship of a fulfilled order -> ${again.status} ${again.body.error}`);
    assert.equal(again.status, 409);
    const s = await soStatus(soId);
    assert.equal(s.lines[0].fulfilled_qty, "2.0000");
  });

  it("an expired hold is swept and the stock becomes available again", async () => {
    const sku = await freshProduct();
    await stockUp(api, sku, "1", "10.00");
    const soId = await makeSalesOrder(api, sku, "1");
    await call(api, "sales@nw.test", "POST", `/sales-orders/${soId}/confirm`, { ttl_minutes: 15 });
    assert.equal((await balanceOf(sku)).available, "0.0000");

    // Backdate the hold rather than waiting 15 minutes. created_at has to move
    // too: res_expiry_sane requires expires_at > created_at, and it rejected the
    // first version of this test for writing a row that could never exist.
    await sql(
      `UPDATE stock_reservations
          SET created_at = now() - interval '30 min',
              expires_at = now() - interval '1 min'
        WHERE sales_order_line_id IN (SELECT id FROM sales_order_lines WHERE so_id = $1)
          AND status = 'HELD'`, [soId]);

    const swept = await call(api, "ship@nw.test", "POST", "/reservations/expire");
    const balance = await balanceOf(sku);
    console.log(`  [fulfil] sweep expired=${swept.body.expired} -> available=${balance.available}`);
    assert.equal(swept.body.expired, 1);
    assert.equal(balance.available, "1.0000");

    const ship = await call(api, "ship@nw.test", "POST", `/sales-orders/${soId}/fulfil`);
    assert.equal(ship.status, 409, "an expired hold cannot be shipped");

    // Idempotent: running the sweep again is a no-op, not an error.
    const again = await call(api, "ship@nw.test", "POST", "/reservations/expire");
    assert.equal(again.body.expired, 0);
  });
});

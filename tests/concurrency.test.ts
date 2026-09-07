import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../src/db.js";
import {
  type Api, balanceOf, call, freshProduct, makeSalesOrder, sql, startApi, stockUp, uniq,
} from "./helpers.js";

let api: Api;
before(async () => { api = await startApi(); });
after(async () => { await api.close(); await closePool(); });

describe("Requirement 2 -- reservation under concurrent load", () => {
  it("never reserves more than is on hand when 12 requests race for 3 units", async () => {
    const sku = await freshProduct();
    await stockUp(api, sku, "3", "10.00");

    const CONTENDERS = 12;
    const orders = await Promise.all(
      Array.from({ length: CONTENDERS }, () => makeSalesOrder(api, sku, "1")));

    // Fire every confirmation at once. Promise.all does not stagger, and the
    // pg pool is 20, so these genuinely overlap in the database.
    const responses = await Promise.all(
      orders.map((id) => call(api, "sales@nw.test", "POST", `/sales-orders/${id}/confirm`)));

    const failures = responses.filter((r) => r.status !== 200);
    assert.equal(failures.length, 0,
      `every request should get a definite answer, got: ${JSON.stringify(failures.slice(0, 3))}`);

    const reserved = responses.map((r) => Number(r.body.lines[0].reserved));
    const totalReserved = reserved.reduce((a, b) => a + b, 0);
    const winners = reserved.filter((q) => q > 0).length;

    const balance = await balanceOf(sku);
    console.log(`  [concurrency] ${CONTENDERS} requests, 3 units:`,
      `winners=${winners} totalReserved=${totalReserved}`,
      `on_hand=${balance.on_hand_qty} reserved=${balance.reserved_qty} available=${balance.available}`);

    assert.equal(totalReserved, 3, "exactly the available quantity is reserved, no more");
    assert.equal(winners, 3, "exactly three of twelve requests win a unit");
    assert.equal(Number(balance.on_hand_qty), 3, "on hand is untouched by reservations");
    assert.equal(Number(balance.reserved_qty), 3, "projected reserved matches the holds");
    assert.ok(Number(balance.available) >= 0, "available never goes negative");

    // The losers are told they are backordered, not handed a 500.
    const backordered = responses.filter((r) => Number(r.body.lines[0].reserved) === 0);
    assert.equal(backordered.length, 9);
    for (const r of backordered) assert.equal(r.body.lines[0].backordered, "1.0000");

    // And the database agrees independently of the API's own arithmetic.
    const { rows } = await sql(
      `SELECT COALESCE(SUM(r.qty),0)::text AS held
         FROM stock_reservations r JOIN products p ON p.id = r.product_id
        WHERE p.sku = $1 AND r.status = 'HELD'`, [sku]);
    assert.equal(rows[0].held, "3.0000");
  });

  it("stays correct when 20 requests race for 1 unit", async () => {
    const sku = await freshProduct();
    await stockUp(api, sku, "1", "5.00");
    const orders = await Promise.all(
      Array.from({ length: 20 }, () => makeSalesOrder(api, sku, "1")));
    const responses = await Promise.all(
      orders.map((id) => call(api, "sales@nw.test", "POST", `/sales-orders/${id}/confirm`)));

    const winners = responses.filter((r) => Number(r.body.lines[0].reserved) > 0);
    const balance = await balanceOf(sku);
    console.log(`  [concurrency] 20 requests, 1 unit: winners=${winners.length}`,
      `reserved=${balance.reserved_qty} available=${balance.available}`);
    assert.equal(winners.length, 1, "exactly one winner");
    assert.equal(Number(balance.reserved_qty), 1);
    assert.ok(Number(balance.available) >= 0);
  });

  it("two multi-line orders over the same SKUs in opposite order do not deadlock", async () => {
    const a = await freshProduct();
    const b = await freshProduct();
    await stockUp(api, a, "10", "10.00");
    await stockUp(api, b, "10", "20.00");

    // The lines are listed in opposite order on purpose. confirmSalesOrder
    // locks by (product_id, warehouse_id) regardless, which is what removes
    // the caller's ability to create a lock cycle.
    const mk = async (first: string, second: string) => {
      const so = await call(api, "sales@nw.test", "POST", "/sales-orders", {
        so_number: uniq("SO"), customer_code: "CUST-1",
        lines: [
          { sku: first, warehouse: "WH1", qty: "1", unit_price: "30.00" },
          { sku: second, warehouse: "WH1", qty: "1", unit_price: "30.00" },
        ],
      });
      return so.body.sales_order_id as number;
    };
    const [x, y] = await Promise.all([mk(a, b), mk(b, a)]);

    const rounds = await Promise.all([
      call(api, "sales@nw.test", "POST", `/sales-orders/${x}/confirm`),
      call(api, "sales@nw.test", "POST", `/sales-orders/${y}/confirm`),
    ]);
    const deadlocks = rounds.filter((r) => r.body?.error === "deadlock");
    console.log(`  [concurrency] opposite-order multi-line: statuses=${rounds.map((r) => r.status)}`,
      `deadlocks=${deadlocks.length}`);
    assert.equal(deadlocks.length, 0, "ordered locking means no 40P01");
    for (const r of rounds) assert.equal(r.status, 200);
  });

  it("the no_oversell backstop fires if a caller bypasses the service", async () => {
    // This is the check on the check. If the assertions above ever pass because
    // nothing is really being enforced, this test would pass too -- so prove
    // the database refuses an unlocked write that would oversell.
    const sku = await freshProduct();
    await stockUp(api, sku, "1", "10.00");
    const soId = await makeSalesOrder(api, sku, "1");
    const { rows } = await sql(
      `SELECT l.id, l.product_id, l.warehouse_id FROM sales_order_lines l WHERE l.so_id = $1`,
      [soId]);

    await sql(
      `INSERT INTO stock_reservations (sales_order_line_id, product_id, warehouse_id, qty, expires_at)
       VALUES ($1,$2,$3,1, now() + interval '10 min')`,
      [rows[0].id, rows[0].product_id, rows[0].warehouse_id]);

    const second = await makeSalesOrder(api, sku, "1");
    const l2 = await sql(
      `SELECT l.id, l.product_id, l.warehouse_id FROM sales_order_lines l WHERE l.so_id = $1`,
      [second]);

    await assert.rejects(
      () => sql(
        `INSERT INTO stock_reservations (sales_order_line_id, product_id, warehouse_id, qty, expires_at)
         VALUES ($1,$2,$3,1, now() + interval '10 min')`,
        [l2.rows[0].id, l2.rows[0].product_id, l2.rows[0].warehouse_id]),
      (err: any) => {
        console.log(`  [backstop] direct insert refused: ${err.constraint}`);
        assert.equal(err.constraint, "no_oversell");
        return true;
      },
      "a reservation written without taking the lock must still be refused");
  });
});

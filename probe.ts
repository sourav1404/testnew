import { createApp } from "./src/app.js";
import { closePool } from "./src/db.js";

const s = createApp().listen(0);
const port = (s.address() as any).port;
const call = async (tok: string | null, m: string, p: string, b?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m,
    headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
};

async function main() {
  console.log("PROBE 1: purchase order with an unknown SKU");
  const po = await call("agent@nw.test", "POST", "/purchase-orders", {
    po_number: "PROBE-1", supplier_code: "SUP-1",
    lines: [{ sku: "DOES-NOT-EXIST", warehouse: "WH1", qty: "10", unit_price: "5.00" }] });
  console.log("  ->", po.status, JSON.stringify(po.body));
  if (po.status === 201) {
    const d = await call("agent@nw.test", "GET", `/purchase-orders/${po.body.purchase_order_id}`);
    console.log("  !! PO has", d.body.lines.length, "line(s) but total_amount", d.body.total_amount);
  }

  console.log("\nPROBE 2: sales order with an unknown warehouse, then confirm");
  const so = await call("sales@nw.test", "POST", "/sales-orders", {
    so_number: "PROBE-2", customer_code: "CUST-1",
    lines: [{ sku: "SKU-001", warehouse: "NOPE", qty: "1", unit_price: "9.00" }] });
  console.log("  create ->", so.status, JSON.stringify(so.body));
  if (so.status === 201) {
    const d = await call("sales@nw.test", "GET", `/sales-orders/${so.body.sales_order_id}`);
    console.log("  !! SO has", d.body.lines.length, "line(s)");
    const c = await call("sales@nw.test", "POST", `/sales-orders/${so.body.sales_order_id}/confirm`);
    console.log("  confirm ->", c.status, JSON.stringify(c.body).slice(0, 140));
  }

  console.log("\nPROBE 3: purchase order with zero lines");
  console.log("  ->", JSON.stringify(await call("agent@nw.test", "POST", "/purchase-orders",
    { po_number: "PROBE-3", supplier_code: "SUP-1", lines: [] })));

  console.log("\nPROBE 4: sales order with zero lines, then confirm");
  const so0 = await call("sales@nw.test", "POST", "/sales-orders",
    { so_number: "PROBE-4", customer_code: "CUST-1", lines: [] });
  console.log("  create ->", so0.status, JSON.stringify(so0.body));
  if (so0.status === 201) {
    const c = await call("sales@nw.test", "POST", `/sales-orders/${so0.body.sales_order_id}/confirm`);
    console.log("  confirm ->", c.status, JSON.stringify(c.body));
  }

  console.log("\nPROBE 5: negative / zero quantities");
  for (const q of ["-5", "0"]) {
    const r = await call("agent@nw.test", "POST", "/purchase-orders", {
      po_number: `PROBE-5-${q}`, supplier_code: "SUP-1",
      lines: [{ sku: "SKU-001", warehouse: "WH1", qty: q, unit_price: "5.00" }] });
    console.log(`  qty=${q} ->`, r.status, JSON.stringify(r.body).slice(0, 90));
  }

  console.log("\nPROBE 6: non-numeric money and injection-shaped input");
  for (const v of ["abc", "1e400", "'; DROP TABLE users; --"]) {
    const r = await call("agent@nw.test", "POST", "/purchase-orders", {
      po_number: `PROBE-6-${Math.random()}`, supplier_code: "SUP-1",
      lines: [{ sku: "SKU-001", warehouse: "WH1", qty: "1", unit_price: v }] });
    console.log(`  unit_price=${JSON.stringify(v)} ->`, r.status, JSON.stringify(r.body).slice(0, 90));
  }

  console.log("\nPROBE 7: does the users table still exist?");
  const who = await call("agent@nw.test", "GET", "/whoami");
  console.log("  ->", who.status, JSON.stringify(who.body).slice(0, 100));

  s.close(); await closePool();
}
main();

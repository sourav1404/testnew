import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { pool } from "../src/db.js";

export interface Api {
  base: string;
  close: () => Promise<void>;
}

/** Boots the real app on an ephemeral port. The tests talk HTTP, so the RBAC
 *  middleware and error mapper are exercised rather than bypassed. */
export async function startApi(): Promise<Api> {
  const server: Server = await new Promise((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface Res<T = any> { status: number; body: T }

export async function call<T = any>(
  api: Api, token: string | null, method: string, path: string, body?: unknown,
): Promise<Res<T>> {
  const res = await fetch(api.base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export const sql = (text: string, params: unknown[] = []) => pool.query(text, params);

let n = 0;
/** Unique per call, so parallel test files never contend for the same stock. */
export const uniq = (prefix: string) =>
  `${prefix}-${process.pid.toString(36)}-${Date.now().toString(36)}-${n++}`;

/** Creates a product nobody else is touching and returns its SKU. */
export async function freshProduct(): Promise<string> {
  const sku = uniq("SKU");
  await sql(`INSERT INTO products (sku, name) VALUES ($1, $1)`, [sku]);
  return sku;
}

/** PO -> approve -> receive, through the API, so stock arrives the real way. */
export async function stockUp(
  api: Api, sku: string, qty: string, unitPrice = "10.00", warehouse = "WH1",
): Promise<void> {
  const po = await call(api, "agent@nw.test", "POST", "/purchase-orders", {
    po_number: uniq("PO"), supplier_code: "SUP-1",
    lines: [{ sku, warehouse, qty, unit_price: unitPrice }],
  });
  if (po.status !== 201) throw new Error(`PO failed: ${JSON.stringify(po.body)}`);
  const id = po.body.purchase_order_id;

  const appr = await call(api, "manager@nw.test", "POST", `/purchase-orders/${id}/approve`);
  if (appr.status !== 200) throw new Error(`approve failed: ${JSON.stringify(appr.body)}`);

  const detail = await call(api, "agent@nw.test", "GET", `/purchase-orders/${id}`);
  const lineId = Number(detail.body.lines[0].po_line_id);

  const gr = await call(api, "wh@nw.test", "POST", `/purchase-orders/${id}/goods-receipts`, {
    lines: [{ po_line_id: lineId, received_qty: qty }],
  });
  if (gr.status !== 201) throw new Error(`receipt failed: ${JSON.stringify(gr.body)}`);
}

export async function makeSalesOrder(
  api: Api, sku: string, qty: string, unitPrice = "20.00", warehouse = "WH1",
): Promise<number> {
  const so = await call(api, "sales@nw.test", "POST", "/sales-orders", {
    so_number: uniq("SO"), customer_code: "CUST-1",
    lines: [{ sku, warehouse, qty, unit_price: unitPrice }],
  });
  if (so.status !== 201) throw new Error(`SO failed: ${JSON.stringify(so.body)}`);
  return so.body.sales_order_id;
}

export async function balanceOf(sku: string, warehouse = "WH1") {
  const { rows } = await sql(
    `SELECT b.on_hand_qty::text, b.reserved_qty::text,
            (b.on_hand_qty - b.reserved_qty)::text AS available, b.avg_unit_cost::text
       FROM stock_balances b JOIN products p ON p.id = b.product_id
       JOIN warehouses w ON w.id = b.warehouse_id
      WHERE p.sku = $1 AND w.code = $2`, [sku, warehouse]);
  return rows[0] ?? { on_hand_qty: "0", reserved_qty: "0", available: "0", avg_unit_cost: "0" };
}

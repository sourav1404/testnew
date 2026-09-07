const API = "http://localhost:3000";

/** Calls the API the way a second, non-browser actor would. */
export async function api<T>(
  token: string, method: "GET" | "POST", path: string, body?: unknown,
): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "idempotency-key": `e2e-${Math.random().toString(36).slice(2)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

let n = 0;
export const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${n++}`;

/**
 * Stock arrives the way it does in production: raise a PO, approve it as a
 * different role, receive against it. No direct writes, so if any of that is
 * broken the test says so rather than working around it.
 */
export async function seedStock(sku: string, qty: string, unitPrice = "10.00"): Promise<number> {
  const po = await api<{ purchase_order_id: number }>(
    "agent@nw.test", "POST", "/purchase-orders", {
      po_number: uniq("PO"), supplier_code: "SUP-1",
      lines: [{ sku, warehouse: "WH1", qty, unit_price: unitPrice }],
    });
  await api("manager@nw.test", "POST", `/purchase-orders/${po.purchase_order_id}/approve`);
  const detail = await api<{ lines: Array<{ po_line_id: string }> }>(
    "agent@nw.test", "GET", `/purchase-orders/${po.purchase_order_id}`);
  await api("wh@nw.test", "POST", `/purchase-orders/${po.purchase_order_id}/goods-receipts`, {
    lines: [{ po_line_id: Number(detail.lines[0]!.po_line_id), received_qty: qty }],
  });
  return po.purchase_order_id;
}

/** An approved PO with nothing received, ready for a receipt test. */
export async function approvedPo(sku: string, qty: string, unitPrice = "4.00") {
  const po = await api<{ purchase_order_id: number }>(
    "agent@nw.test", "POST", "/purchase-orders", {
      po_number: uniq("PO"), supplier_code: "SUP-1",
      lines: [{ sku, warehouse: "WH1", qty, unit_price: unitPrice }],
    });
  await api("manager@nw.test", "POST", `/purchase-orders/${po.purchase_order_id}/approve`);
  return po.purchase_order_id;
}

export async function availability(sku: string): Promise<string> {
  const r = await api<{ items: Array<{ available: string }> }>(
    "wh@nw.test", "GET", `/inventory/availability?sku=${encodeURIComponent(sku)}`);
  return r.items[0]?.available ?? "0";
}

/** Creates a sales order and confirms it, as a second session would. */
export async function reserveElsewhere(sku: string, qty: string): Promise<number> {
  const so = await api<{ sales_order_id: number }>("sales@nw.test", "POST", "/sales-orders", {
    so_number: uniq("SO"), customer_code: "CUST-1",
    lines: [{ sku, warehouse: "WH1", qty, unit_price: "20.00" }],
  });
  await api("sales@nw.test", "POST", `/sales-orders/${so.sales_order_id}/confirm`);
  return so.sales_order_id;
}

/** Sets the console's persona before the app boots, so the first render is
 *  already the role under test rather than a switch mid-flight. */
export const asPersona = (token: string) => ({
  storageState: {
    cookies: [],
    origins: [{
      origin: "http://localhost:5174",
      localStorage: [{ name: "northwind.token", value: token }],
    }],
  },
});

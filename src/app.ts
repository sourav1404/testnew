import express, { type NextFunction, type Request, type Response } from "express";
import { withTx } from "./db.js";
import { ApiError, toApiError } from "./errors.js";
import { actorOf, authenticate, requirePermission } from "./auth.js";
import { runIdempotent } from "./idempotency.js";
import * as inventory from "./modules/inventory.js";
import * as ledger from "./modules/ledger.js";
import * as procurement from "./modules/procurement.js";
import * as sales from "./modules/sales.js";

/** Express 4 does not forward rejected promises, so every handler goes through this. */
function h(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

const num = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ApiError(400, "bad_request", `${name} must be a number`);
  return n;
};
const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v.length === 0) {
    throw new ApiError(400, "bad_request", `${name} is required`);
  }
  return v;
};

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => { res.json({ status: "ok" }); });

  // Everything past this point needs an identity. Authorisation is per route.
  app.use(authenticate);

  app.get("/whoami", (req, res) => {
    const a = actorOf(req);
    res.json({ id: a.id, email: a.email, roles: a.roles, permissions: [...a.permissions].sort() });
  });

  // ------------------------------------------------------------- inventory
  app.get("/inventory/availability", requirePermission("inventory.read"), h(async (req, res) => {
    const rows = await withTx((tx) => inventory.availability(
      tx, req.query.sku as string | undefined, req.query.warehouse as string | undefined));
    res.json({ items: rows });
  }));

  app.get("/inventory/movements", requirePermission("inventory.read"), h(async (req, res) => {
    const rows = await withTx((tx) => inventory.movements(tx, req.query.sku as string | undefined));
    res.json({ movements: rows });
  }));

  app.post("/inventory/adjustments", requirePermission("inventory.adjust"), h(async (req, res) => {
    const b = req.body ?? {};
    await runIdempotent(req, res, 201, (tx) => inventory.postAdjustment(tx, {
      sku: str(b.sku, "sku"), warehouse: str(b.warehouse, "warehouse"),
      qtyDelta: str(b.qty_delta, "qty_delta"), reason: str(b.reason, "reason"),
      actorId: actorOf(req).id,
    }));
  }));

  // ----------------------------------------------------------- procurement
  app.post("/purchase-orders", requirePermission("po.create"), h(async (req, res) => {
    const b = req.body ?? {};
    await runIdempotent(req, res, 201, (tx) => procurement.createPurchaseOrder(tx, {
      poNumber: str(b.po_number, "po_number"),
      supplierCode: str(b.supplier_code, "supplier_code"),
      lines: (b.lines ?? []).map((l: Record<string, unknown>) => ({
        sku: str(l.sku, "sku"), warehouse: str(l.warehouse, "warehouse"),
        qty: str(l.qty, "qty"), unitPrice: str(l.unit_price, "unit_price"),
      })),
      actorId: actorOf(req).id,
    }));
  }));

  app.post("/purchase-orders/:id/approve", requirePermission("po.approve"), h(async (req, res) => {
    await runIdempotent(req, res, 200, (tx) =>
      procurement.approvePurchaseOrder(tx, num(req.params.id, "id"), actorOf(req).id));
  }));

  app.get("/purchase-orders/:id", requirePermission("po.read"), h(async (req, res) => {
    const out = await withTx((tx) => procurement.purchaseOrderStatus(tx, num(req.params.id, "id")));
    res.json(out);
  }));

  app.post("/purchase-orders/:id/goods-receipts", requirePermission("receipt.create"),
    h(async (req, res) => {
      const actor = actorOf(req);
      const b = req.body ?? {};
      await runIdempotent(req, res, 201, (tx) => procurement.receiveGoods(tx, {
        poId: num(req.params.id, "id"),
        lines: (b.lines ?? []).map((l: Record<string, unknown>) => ({
          poLineId: num(l.po_line_id, "po_line_id"),
          receivedQty: str(l.received_qty, "received_qty"),
          allowOverReceipt: l.allow_over_receipt === true,
        })),
        actorId: actor.id,
        // Asking for it is not the same as being allowed to: the permission is
        // checked here, server-side, not inferred from the request body.
        mayOverReceive: actor.permissions.has("receipt.over_receive"),
      }));
    }));

  // ----------------------------------------------------------------- sales
  app.post("/sales-orders", requirePermission("so.create"), h(async (req, res) => {
    const b = req.body ?? {};
    await runIdempotent(req, res, 201, (tx) => sales.createSalesOrder(tx, {
      soNumber: str(b.so_number, "so_number"),
      customerCode: str(b.customer_code, "customer_code"),
      lines: (b.lines ?? []).map((l: Record<string, unknown>) => ({
        sku: str(l.sku, "sku"), warehouse: str(l.warehouse, "warehouse"),
        qty: str(l.qty, "qty"), unitPrice: str(l.unit_price, "unit_price"),
      })),
      actorId: actorOf(req).id,
    }));
  }));

  app.post("/sales-orders/:id/confirm", requirePermission("so.confirm"), h(async (req, res) => {
    const ttl = req.body?.ttl_minutes ? num(req.body.ttl_minutes, "ttl_minutes") : 15;
    await runIdempotent(req, res, 200, (tx) =>
      sales.confirmSalesOrder(tx, num(req.params.id, "id"), ttl, actorOf(req).id));
  }));

  app.post("/sales-orders/:id/fulfil", requirePermission("so.fulfil"), h(async (req, res) => {
    await runIdempotent(req, res, 200, (tx) =>
      sales.fulfilSalesOrder(tx, num(req.params.id, "id"), actorOf(req).id));
  }));

  app.get("/sales-orders/:id", requirePermission("so.read"), h(async (req, res) => {
    const out = await withTx((tx) => sales.salesOrderStatus(tx, num(req.params.id, "id")));
    res.json(out);
  }));

  app.post("/reservations/expire", requirePermission("so.fulfil"), h(async (_req, res) => {
    const expired = await withTx((tx) => sales.expireReservations(tx));
    res.json({ expired });
  }));

  // ---------------------------------------------------------------- ledger
  app.get("/ledger/trial-balance", requirePermission("ledger.read"), h(async (req, res) => {
    const out = await withTx((tx) => ledger.trialBalance(tx, req.query.as_of as string | undefined));
    res.json(out);
  }));

  app.get("/reports/inventory-reconciliation", requirePermission("ledger.read"),
    h(async (req, res) => {
      const out = await withTx((tx) =>
        ledger.reconcileInventory(tx, req.query.as_of as string | undefined));
      res.json(out);
    }));

  app.post("/ledger/entries", requirePermission("ledger.post_manual"), h(async (req, res) => {
    const b = req.body ?? {};
    await runIdempotent(req, res, 201, async (tx) => ({ ledger_entry_id: await ledger.postEntry(tx, {
      entryDate: b.entry_date, sourceDoc: "manual_journal",
      sourceDocId: num(b.source_doc_id ?? 0, "source_doc_id"),
      memo: str(b.memo, "memo"), createdBy: actorOf(req).id,
      lines: (b.lines ?? []).map((l: Record<string, unknown>) => ({
        account: str(l.account, "account"), amount: str(l.amount, "amount"),
        productId: l.product_id ? num(l.product_id, "product_id") : undefined,
        warehouseId: l.warehouse_id ? num(l.warehouse_id, "warehouse_id") : undefined,
      })),
    }) }));
  }));

  app.post("/ledger/entries/:id/reverse", requirePermission("ledger.reverse"),
    h(async (req, res) => {
      await runIdempotent(req, res, 201, async (tx) => ({
        reversing_entry_id: await ledger.reverseEntry(
          tx, num(req.params.id, "id"), actorOf(req).id, str(req.body?.memo, "memo")),
        reverses_id: num(req.params.id, "id"),
      }));
    }));

  app.use((_req, res) => { res.status(404).json({ error: "not_found" }); });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const api = toApiError(err);
    if (api.status >= 500) console.error("unhandled", err);
    res.status(api.status).json({ error: api.code, message: api.message, ...(api.detail ?? {}) });
  });

  return app;
}

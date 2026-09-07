import { useState } from "react";
import type { PurchaseOrder, ReceiptResult, Whoami } from "../api/types.js";
import { ApiError, newIdempotencyKey, request } from "../api/client.js";
import { useResource } from "../hooks/useResource.js";
import { Async, ErrorBanner, Empty } from "../components/Async.jsx";
import { Locked, Num, Panel, Pill, Table } from "../components/bits.jsx";
import { can } from "../session.js";

interface DraftLine { sku: string; warehouse: string; qty: string; unitPrice: string }

/**
 * Outstanding quantity is never stored in Stage 2 -- po_line_status derives it
 * from the sum of receipts -- so this view can show it after each partial
 * receipt without any counter to keep in step.
 *
 * The over-receipt path is the interesting one, and the console deliberately
 * does not pre-validate it. Whether 12 against an order of 10 is allowed
 * depends on a permission the browser does not hold and a received total that
 * another receipt may have moved a moment ago. Guessing here would either
 * block a legitimate authorised receipt or promise one that the server refuses,
 * so the request goes and the server's answer -- including its arithmetic -- is
 * what the operator sees.
 */
export function Procurement({ me, token }: { me: Whoami; token: string }) {
  const mayCreate = can(me, "po.create");
  const mayApprove = can(me, "po.approve");
  const mayReceive = can(me, "receipt.create");
  const mayOverReceive = can(me, "receipt.over_receive");
  const mayRead = can(me, "po.read");

  const [lines, setLines] = useState<DraftLine[]>(
    [{ sku: "", warehouse: "WH1", qty: "100", unitPrice: "2.50" }]);
  const [poId, setPoId] = useState<number | null>(null);
  const [receiptQty, setReceiptQty] = useState<Record<string, string>>({});
  const [allowOver, setAllowOver] = useState(false);
  const [policy, setPolicy] = useState<"reject_batch" | "reject_line">("reject_batch");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [receipt, setReceipt] = useState<ReceiptResult | null>(null);

  const po = useResource<PurchaseOrder>(
    mayRead && poId ? `/purchase-orders/${poId}` : null, token,
    { enabled: mayRead && poId !== null });

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, "unknown", String(e))); }
    finally { setBusy(null); }
  };

  const create = () => run("create", async () => {
    const { data } = await request<{ purchase_order_id: number }>("/purchase-orders", {
      token, method: "POST", idempotencyKey: newIdempotencyKey(),
      body: {
        po_number: `PO-${Date.now().toString(36).toUpperCase()}`,
        supplier_code: "SUP-1",
        lines: lines.map((l) => ({
          sku: l.sku, warehouse: l.warehouse, qty: l.qty, unit_price: l.unitPrice,
        })),
      },
    });
    setPoId(data.purchase_order_id);
    setReceipt(null);
  });

  const approve = () => run("approve", async () => {
    await request(`/purchase-orders/${poId}/approve`, {
      token, method: "POST", idempotencyKey: newIdempotencyKey(),
    });
    await po.reload();
  });

  const receiveGoods = () => run("receive", async () => {
    const body = {
      on_over_receipt: policy,
      lines: Object.entries(receiptQty)
        .filter(([, qty]) => qty.trim() !== "")
        .map(([id, qty]) => ({
          po_line_id: Number(id), received_qty: qty,
          ...(allowOver ? { allow_over_receipt: true } : {}),
        })),
    };
    const { data, replayed } = await request<ReceiptResult>(
      `/purchase-orders/${poId}/goods-receipts`,
      { token, method: "POST", idempotencyKey: newIdempotencyKey(), body });
    setReceipt(data);
    if (replayed) {
      setError(new ApiError(200, "idempotent_replay",
        "This receipt had already been recorded; the original result is shown."));
    }
    setReceiptQty({});
    await po.reload();
  });

  return (
    <>
      <Panel title="New purchase order">
        {!mayCreate ? <Locked permission="po.create" /> : (
          <>
            {lines.map((l, i) => (
              <div className="line-row" key={i}>
                <label>SKU
                  <input value={l.sku} placeholder="SKU-001"
                    onChange={(e) => setLines(lines.map((x, j) =>
                      j === i ? { ...x, sku: e.target.value } : x))} />
                </label>
                <label>Warehouse
                  <select value={l.warehouse}
                    onChange={(e) => setLines(lines.map((x, j) =>
                      j === i ? { ...x, warehouse: e.target.value } : x))}>
                    <option>WH1</option><option>WH2</option>
                  </select>
                </label>
                <label>Ordered qty
                  <input value={l.qty} inputMode="decimal"
                    onChange={(e) => setLines(lines.map((x, j) =>
                      j === i ? { ...x, qty: e.target.value } : x))} />
                </label>
                <label>Unit price
                  <input value={l.unitPrice} inputMode="decimal"
                    onChange={(e) => setLines(lines.map((x, j) =>
                      j === i ? { ...x, unitPrice: e.target.value } : x))} />
                </label>
                {lines.length > 1 ? (
                  <button type="button" className="link"
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}>remove</button>
                ) : null}
              </div>
            ))}
            <div className="panel-actions">
              <button type="button" className="link"
                onClick={() => setLines([...lines,
                  { sku: "", warehouse: "WH1", qty: "10", unitPrice: "4.00" }])}>add line</button>
              <button type="button" disabled={busy !== null || lines.every((l) => !l.sku)}
                onClick={create}>{busy === "create" ? "Creating…" : "Create order"}</button>
            </div>
          </>
        )}
        <p className="note">
          Maker and checker are separate roles and the constraint is in the database:
          the agent who raises a PO cannot approve it, and the two roles cannot be
          held by one person.
        </p>
        {error ? <ErrorBanner error={error} /> : null}
      </Panel>

      <Panel title="Open a purchase order"
             actions={
               <input placeholder="PO id" inputMode="numeric" className="narrow"
                 onChange={(e) => {
                   const n = Number(e.target.value);
                   setPoId(Number.isFinite(n) && n > 0 ? n : null);
                 }} />
             }>
        {!mayRead ? <Locked permission="po.read" /> : poId === null
          ? <Empty>Create an order above, or type an id to open one.</Empty>
          : (
            <Async state={po.state} revalidating={po.revalidating} onRetry={() => void po.reload()}>
              {(order) => (
                <>
                  <p>
                    <code>{order.po_number}</code> <Pill>{order.status}</Pill>{" "}
                    total <Num v={order.total_amount} />
                    {order.approved_by
                      ? <span className="muted"> -- approved by user {order.approved_by}</span>
                      : null}
                  </p>

                  {order.status === "PENDING_APPROVAL" ? (
                    mayApprove
                      ? <button type="button" disabled={busy !== null} onClick={approve}>
                          {busy === "approve" ? "Approving…" : "Approve"}
                        </button>
                      : <Locked permission="po.approve" />
                  ) : null}

                  <Table head={["Line", "SKU", "Wh", "Ordered", "Received", "Outstanding", "Receive now"]}>
                    {order.lines.map((l) => (
                      <tr key={l.po_line_id} className={l.is_over_received ? "row-warn" : ""}>
                        <td><code>{l.po_line_id}</code></td>
                        <td><code>{l.sku}</code></td>
                        <td>{l.warehouse}</td>
                        <td><Num v={l.ordered_qty} /></td>
                        <td><Num v={l.received_qty} /></td>
                        {/* Derived from the sum of receipts, so a partial receipt
                            needs no counter kept in step. Negative means an
                            authorised over-receipt, shown rather than clamped. */}
                        <td className={Number(l.outstanding_qty) < 0 ? "cell-neg" : ""}>
                          <Num v={l.outstanding_qty} />
                          {l.is_over_received ? <span className="tag">over-received</span> : null}
                        </td>
                        <td>
                          {mayReceive && ["APPROVED", "RECEIVING"].includes(order.status)
                            ? <input className="narrow" inputMode="decimal" placeholder="0"
                                value={receiptQty[l.po_line_id] ?? ""}
                                onChange={(e) => setReceiptQty({
                                  ...receiptQty, [l.po_line_id]: e.target.value })} />
                            : <span className="muted">--</span>}
                        </td>
                      </tr>
                    ))}
                  </Table>

                  {!mayReceive ? <Locked permission="receipt.create" /> : null}
                  {mayReceive && ["APPROVED", "RECEIVING"].includes(order.status) ? (
                    <div className="receipt-controls">
                      <label className="check">
                        <input type="checkbox" checked={allowOver}
                          disabled={!mayOverReceive}
                          onChange={(e) => setAllowOver(e.target.checked)} />
                        Accept an over-receipt
                        {!mayOverReceive
                          ? <span className="muted"> -- needs <code>receipt.over_receive</code></span>
                          : null}
                      </label>
                      <label>On over-receipt
                        <select value={policy}
                          onChange={(e) => setPolicy(e.target.value as typeof policy)}>
                          <option value="reject_batch">reject the whole receipt</option>
                          <option value="reject_line">book the good lines, report the bad</option>
                        </select>
                      </label>
                      <button type="button"
                        disabled={busy !== null || Object.values(receiptQty).every((v) => !v.trim())}
                        onClick={receiveGoods}>
                        {busy === "receive" ? "Recording…" : "Record goods receipt"}
                      </button>
                    </div>
                  ) : null}

                  {receipt ? (
                    <div className="banner banner-info">
                      <strong>Receipt #{receipt.goods_receipt_id}</strong>{" "}
                      entry <code>{receipt.ledger_entry_id}</code>{" "}
                      gross <Num v={receipt.gross_value} />{" "}
                      <span className="tag">{receipt.policy.replace("_", " ")}</span>
                      <ul>
                        {receipt.lines.map((l) => (
                          <li key={l.po_line_id}>
                            line <code>{l.po_line_id}</code>: booked <Num v={l.received_qty} />,
                            outstanding <Num v={l.outstanding_qty} />
                            {l.over_receipt ? <span className="tag">over-receipt</span> : null}
                          </li>
                        ))}
                        {receipt.refused.map((r) => (
                          <li key={`r${r.po_line_id}`} className="warn-text">
                            line <code>{r.po_line_id}</code> refused: ordered <Num v={r.ordered} />,
                            already <Num v={r.already_received} />, attempted <Num v={r.attempted} />
                            {" -- "}{r.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              )}
            </Async>
          )}
      </Panel>
    </>
  );
}

import { useMemo, useState } from "react";
import type { AvailabilityRow, ConfirmResult, SalesOrder, Whoami } from "../api/types.js";
import { ApiError, newIdempotencyKey, request } from "../api/client.js";
import { useResource } from "../hooks/useResource.js";
import { Async, ErrorBanner, Empty } from "../components/Async.jsx";
import { Locked, Num, Panel, Pill, Table } from "../components/bits.jsx";
import { can } from "../session.js";

interface Draft { sku: string; warehouse: string; qty: string; unitPrice: string }

/**
 * ordered - shipped - held, on numeric(14,4) strings, without going through a
 * float. The backend keeps these as strings precisely so a cent or a unit
 * cannot round away; parsing them here to subtract would undo that.
 */
export function uncoveredQty(qty: string, fulfilled: string, held: string): string {
  const scale = (v: string): bigint => {
    const [int = "0", frac = ""] = v.trim().split(".");
    return BigInt(int + frac.padEnd(4, "0").slice(0, 4));
  };
  const units = scale(qty) - scale(fulfilled) - scale(held);
  const clamped = units < 0n ? 0n : units;
  const s = clamped.toString().padStart(5, "0");
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
}


/**
 * Requirement 2 lives here: the availability an operator sees before confirming
 * has to be live, because it is the number they are about to promise a customer.
 *
 * Two things make it live rather than merely fetched-once:
 *  - the availability resource polls, and revalidates on window focus, so a
 *    reservation taken by another session shows up without a manual refresh;
 *  - confirming does NOT patch local state. It calls the API and then reloads
 *    both resources. An optimistic "reserved!" would be a lie exactly when it
 *    matters -- on the last unit, where the server may hand it to someone else.
 */
export function Sales({ me, token }: { me: Whoami; token: string }) {
  const mayCreate = can(me, "so.create");
  const mayConfirm = can(me, "so.confirm");
  const mayFulfil = can(me, "so.fulfil");
  const mayRead = can(me, "so.read");

  const stock = useResource<{ items: AvailabilityRow[] }>(
    can(me, "inventory.read") ? "/inventory/availability" : null, token, { pollMs: 3000 });

  const [lines, setLines] = useState<Draft[]>([{ sku: "", warehouse: "WH1", qty: "1", unitPrice: "20.00" }]);
  const [soId, setSoId] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmResult | null>(null);

  const order = useResource<SalesOrder>(
    mayRead && soId ? `/sales-orders/${soId}` : null, token,
    { enabled: mayRead && soId !== null, pollMs: 4000 });

  const byKey = useMemo(() => {
    const m = new Map<string, AvailabilityRow>();
    for (const r of stock.state.data?.items ?? []) m.set(`${r.sku}/${r.warehouse}`, r);
    return m;
  }, [stock.state.data]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, "unknown", String(e))); }
    finally { setBusy(null); }
  };

  const create = () => run("create", async () => {
    const { data } = await request<{ sales_order_id: number }>("/sales-orders", {
      token, method: "POST", idempotencyKey: newIdempotencyKey(),
      body: {
        so_number: `SO-${Date.now().toString(36).toUpperCase()}`,
        customer_code: "CUST-1",
        lines: lines.map((l) => ({
          sku: l.sku, warehouse: l.warehouse, qty: l.qty, unit_price: l.unitPrice,
        })),
      },
    });
    setSoId(data.sales_order_id);
    setConfirmed(null);
    await stock.reload();
  });

  const confirm = () => run("confirm", async () => {
    const { data } = await request<ConfirmResult>(`/sales-orders/${soId}/confirm`, {
      token, method: "POST", idempotencyKey: newIdempotencyKey(), body: { ttl_minutes: 15 },
    });
    setConfirmed(data);
    // Pull the truth back rather than trusting what we just sent.
    await Promise.all([stock.reload(), order.reload()]);
  });

  const fulfil = () => run("fulfil", async () => {
    await request(`/sales-orders/${soId}/fulfil`, {
      token, method: "POST", idempotencyKey: newIdempotencyKey(),
    });
    await Promise.all([stock.reload(), order.reload()]);
  });

  return (
    <>
      <Panel
        title="Live availability"
        note="Polls every 3s and revalidates on focus. Open this console in a second window as a
              different persona, reserve the same SKU there, and watch Available fall here."
        actions={<span className="muted">{stock.revalidating ? "refreshing…" : "live"}</span>}
      >
        <Async state={stock.state} onRetry={() => void stock.reload()}
               empty={<Empty>No stock yet -- receive against a purchase order first.</Empty>}>
          {(d) => d.items.length === 0 ? null : (
            <Table head={["SKU", "Warehouse", "On hand", "Reserved", "Available"]}>
              {d.items.map((r) => (
                <tr key={`${r.sku}/${r.warehouse}`} data-testid={`avail-${r.sku}`}>
                  <td><code>{r.sku}</code></td>
                  <td>{r.warehouse}</td>
                  <td><Num v={r.on_hand_qty} /></td>
                  <td><Num v={r.reserved_qty} /></td>
                  <td data-testid="available"
                      className={Number(r.available) === 0 ? "cell-zero" : "cell-ok"}>
                    <Num v={r.available} />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Async>
      </Panel>

      <Panel title="New sales order">
        {!mayCreate ? <Locked permission="so.create" /> : (
          <>
            {lines.map((l, i) => {
              const live = byKey.get(`${l.sku}/${l.warehouse}`);
              const short = live && Number(l.qty) > Number(live.available);
              return (
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
                  <label>Qty
                    <input value={l.qty} inputMode="decimal"
                      onChange={(e) => setLines(lines.map((x, j) =>
                        j === i ? { ...x, qty: e.target.value } : x))} />
                  </label>
                  <label>Unit price
                    <input value={l.unitPrice} inputMode="decimal"
                      onChange={(e) => setLines(lines.map((x, j) =>
                        j === i ? { ...x, unitPrice: e.target.value } : x))} />
                  </label>
                  {/* The live figure sits next to the input, so the operator sees the
                      constraint while typing rather than after being refused. */}
                  <span className="inline-avail">
                    {live
                      ? <>available <Num v={live.available} />{short
                          ? <em className="warn-text"> -- {l.qty} will partly backorder</em>
                          : null}</>
                      : l.sku ? <em className="muted">unknown SKU</em> : null}
                  </span>
                  {lines.length > 1 ? (
                    <button type="button" className="link"
                      onClick={() => setLines(lines.filter((_, j) => j !== i))}>remove</button>
                  ) : null}
                </div>
              );
            })}
            <div className="panel-actions">
              <button type="button" className="link"
                onClick={() => setLines([...lines,
                  { sku: "", warehouse: "WH1", qty: "1", unitPrice: "20.00" }])}>
                add line
              </button>
              <button type="button" disabled={busy !== null || lines.every((l) => !l.sku)}
                onClick={create}>
                {busy === "create" ? "Creating…" : "Create order"}
              </button>
            </div>
          </>
        )}
        {error ? <ErrorBanner error={error} /> : null}
      </Panel>

      <Panel
        title="Open a sales order"
        note="A fulfilment operator holds so.fulfil but not so.create, so they need to
              open an order someone else raised. Without this the role could not do its job."
        actions={
          <input placeholder="SO id" inputMode="numeric" className="narrow"
            onChange={(e) => {
              const n = Number(e.target.value);
              setSoId(Number.isFinite(n) && n > 0 ? n : null);
              setConfirmed(null);
            }} />
        }
      >
        {!mayRead
          ? <Locked permission="so.read" />
          : soId === null
            ? <Empty>Create an order above, or type an id to open one.</Empty>
            : <p className="muted">Showing order #{soId} below.</p>}
      </Panel>

      {soId ? (
        <Panel
          title={`Sales order #${soId}`}
          actions={
            <>
              {mayConfirm
                ? <button type="button" disabled={busy !== null} onClick={confirm}>
                    {busy === "confirm" ? "Confirming…" : "Confirm and reserve"}
                  </button>
                : null}
              {mayFulfil
                ? <button type="button" disabled={busy !== null} onClick={fulfil}>
                    {busy === "fulfil" ? "Shipping…" : "Fulfil"}
                  </button>
                : null}
            </>
          }
        >
          {!mayConfirm ? <Locked permission="so.confirm" /> : null}
          {!mayFulfil ? <Locked permission="so.fulfil" /> : null}

          {confirmed ? (
            <div className="banner banner-info">
              <strong>Reservation result</strong>
              <ul>
                {confirmed.lines.map((l) => (
                  <li key={l.sku}>
                    <code>{l.sku}</code> reserved <Num v={l.reserved} />
                    {Number(l.backordered) > 0
                      ? <> -- <span className="warn-text">
                          backordered <Num v={l.backordered} /></span></>
                      : null}
                    {l.note ? <span className="muted"> ({l.note})</span> : null}
                  </li>
                ))}
              </ul>
              <p className="muted">
                Partial reservation is deliberate: the order takes what exists and
                backorders the rest rather than being refused whole.
              </p>
            </div>
          ) : null}

          <Async state={order.state} revalidating={order.revalidating}
                 onRetry={() => void order.reload()}>
            {(so) => (
              <>
                <p>Status <Pill>{so.status}</Pill> <span className="muted">{so.so_number}</span></p>
                {/* The backend's own backordered_qty is `qty - fulfilled_qty`, so it
                    counts held stock as backordered, and line_status stays OPEN until
                    something ships. Neither is what an operator needs to know, so the
                    console shows the decomposition and computes uncovered itself:
                    ordered - shipped - held. Both columns are labelled for what they
                    are rather than quietly conflated. */}
                <Table head={["SKU", "Wh", "Ordered", "Held", "Shipped",
                              "Uncovered", "Unshipped (API)", "Line status (API)"]}>
                  {so.lines.map((l) => {
                    const uncovered = uncoveredQty(l.qty, l.fulfilled_qty, l.held_qty);
                    return (
                      <tr key={l.id}>
                        <td><code>{l.sku}</code></td>
                        <td>{l.warehouse}</td>
                        <td><Num v={l.qty} /></td>
                        <td><Num v={l.held_qty} /></td>
                        <td><Num v={l.fulfilled_qty} /></td>
                        <td data-testid="uncovered"
                            className={uncovered !== "0.0000" ? "cell-neg" : ""}>
                          <Num v={uncovered} />
                        </td>
                        <td className="muted"><Num v={l.backordered_qty} /></td>
                        <td><Pill>{l.line_status}</Pill></td>
                      </tr>
                    );
                  })}
                </Table>
                <p className="footnote">
                  <strong>Uncovered</strong> is ordered minus shipped minus held -- the part
                  with no stock behind it. <strong>Unshipped</strong> is the API's
                  <code>backordered_qty</code>, which does not subtract holds; the two differ
                  while a reservation is live, and the console does not hide that.
                </p>
              </>
            )}
          </Async>
        </Panel>
      ) : null}
    </>
  );
}

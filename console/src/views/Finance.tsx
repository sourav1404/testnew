import type { Reconciliation, TrialBalanceRow, Whoami } from "../api/types.js";
import { useResource } from "../hooks/useResource.js";
import { Async, Empty } from "../components/Async.jsx";
import { Money, Num, Panel, Pill, Table } from "../components/bits.jsx";
import { can } from "../session.js";

/**
 * The reconciliation figure is the one number that says whether the whole
 * system is telling the truth: the sum of booked_value over every stock
 * movement against the balance of the Inventory control account. Stage 2 keeps
 * them equal by construction -- a deferred trigger compares each movement to
 * its own ledger line -- so this view is the operator's independent check on
 * that, not a substitute for it.
 */
export function Finance({ me, token }: { me: Whoami; token: string }) {
  const allowed = can(me, "ledger.read");
  const recon = useResource<Reconciliation>(
    allowed ? "/reports/inventory-reconciliation" : null, token,
    { pollMs: 8000, enabled: allowed });
  const tb = useResource<{ accounts: TrialBalanceRow[]; total_must_be_zero: string }>(
    allowed ? "/ledger/trial-balance" : null, token, { enabled: allowed });

  if (!allowed) {
    return <Panel title="Finance"><Empty>Your role cannot read the ledger.</Empty></Panel>;
  }

  return (
    <>
      <Panel title="Inventory reconciliation"
             note="Subledger (sum of stock movement booked_value) against GL account 1300."
             actions={<button type="button" onClick={() => void recon.reload()}>Refresh</button>}>
        <Async state={recon.state} revalidating={recon.revalidating}
               onRetry={() => void recon.reload()}>
          {(r) => (
            <>
              <div className={`verdict verdict-${r.status === "TIES" ? "ok" : "bad"}`}>
                <span className="verdict-label">
                  {r.status === "TIES"
                    ? "Ledger balance matches inventory movements: YES"
                    : "Ledger balance matches inventory movements: NO"}
                </span>
                <dl>
                  <div><dt>Subledger</dt><dd><Money v={r.subledger_value} /></dd></div>
                  <div><dt>GL 1300</dt><dd><Money v={r.gl_inventory_value} /></dd></div>
                  <div><dt>Delta</dt><dd><Money v={r.delta} /></dd></div>
                  <div><dt>Unbalanced entries</dt><dd>{r.unbalanced_entries}</dd></div>
                </dl>
              </div>
              {r.by_product.length === 0
                ? <Empty>No stock to value yet.</Empty>
                : (
                  <Table head={["SKU", "Warehouse", "On hand", "Reserved", "Avg cost", "Value"]}>
                    {r.by_product.map((p) => (
                      <tr key={`${p.sku}/${p.warehouse}`}>
                        <td><code>{p.sku}</code></td>
                        <td>{p.warehouse}</td>
                        <td><Num v={p.on_hand_qty} /></td>
                        <td><Num v={p.reserved_qty} /></td>
                        <td><Num v={p.avg_unit_cost} /></td>
                        <td><Money v={p.value} /></td>
                      </tr>
                    ))}
                  </Table>
                )}
            </>
          )}
        </Async>
      </Panel>

      <Panel title="Trial balance"
             note="Every entry balances and posted entries are immutable; a correction is a reversing entry.">
        <Async state={tb.state} revalidating={tb.revalidating} onRetry={() => void tb.reload()}>
          {(d) => d.accounts.length === 0 ? null : (
            <>
              <Table head={["Account", "Name", "Kind", "Balance"]}>
                {d.accounts.map((a) => (
                  <tr key={a.code}>
                    <td><code>{a.code}</code></td>
                    <td>{a.name}</td>
                    <td className="muted">{a.kind}</td>
                    <td><Money v={a.balance} /></td>
                  </tr>
                ))}
              </Table>
              <p className="footnote">
                Sum of all balances{" "}
                <Pill>{Number(d.total_must_be_zero) === 0 ? "TIES" : "DRIFT"}</Pill>{" "}
                <Money v={d.total_must_be_zero} /> -- double entry means this must be zero.
              </p>
            </>
          )}
        </Async>
      </Panel>
    </>
  );
}

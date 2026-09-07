import { useState } from "react";
import type { AvailabilityRow, MovementRow, Whoami } from "../api/types.js";
import { useResource } from "../hooks/useResource.js";
import { Async, Empty } from "../components/Async.jsx";
import { Num, Panel, Pill, Table } from "../components/bits.jsx";
import { can } from "../session.js";

/**
 * Stock is derived in Stage 2 -- there is no quantity_on_hand column anywhere --
 * so this view shows the projection and, one click away, the append-only
 * movements it is derived from. Being able to check the number against its own
 * history is the point; a total nobody can audit is just a rumour.
 */
export function Warehouse({ me, token }: { me: Whoami; token: string }) {
  const [sku, setSku] = useState<string | null>(null);
  const allowed = can(me, "inventory.read");

  // Balances are contended, so they poll. Movements are append-only history and
  // only refetch when the operator opens a SKU or the window regains focus.
  const stock = useResource<{ items: AvailabilityRow[] }>(
    allowed ? "/inventory/availability" : null, token, { pollMs: 4000, enabled: allowed });
  const moves = useResource<{ movements: MovementRow[] }>(
    allowed && sku ? `/inventory/movements?sku=${encodeURIComponent(sku)}` : null,
    token, { enabled: allowed && sku !== null });

  if (!allowed) return <Panel title="Warehouse"><Empty>Your role cannot read inventory.</Empty></Panel>;

  return (
    <>
      <Panel
        title="Stock on hand"
        note="Derived from stock_movements. Polls every 4s, and revalidates when this window regains focus."
        actions={<button type="button" onClick={() => void stock.reload()}>Refresh</button>}
      >
        <Async
          state={stock.state}
          revalidating={stock.revalidating}
          onRetry={() => void stock.reload()}
          empty={<Empty>No stock anywhere yet. Receive against a purchase order first.</Empty>}
        >
          {(d) => d.items.length === 0 ? null : (
            <Table head={["SKU", "Warehouse", "On hand", "Reserved", "Available", "Avg cost", ""]}>
              {d.items.map((r) => (
                <tr key={`${r.sku}/${r.warehouse}`} className={sku === r.sku ? "row-active" : ""}>
                  <td><code>{r.sku}</code></td>
                  <td>{r.warehouse}</td>
                  <td><Num v={r.on_hand_qty} /></td>
                  <td><Num v={r.reserved_qty} /></td>
                  {/* Available is what a sales rep can actually promise. */}
                  <td className={Number(r.available) === 0 ? "cell-zero" : ""}>
                    <Num v={r.available} />
                  </td>
                  <td><Num v={r.avg_unit_cost} /></td>
                  <td>
                    <button type="button" className="link"
                      onClick={() => setSku(sku === r.sku ? null : r.sku)}>
                      {sku === r.sku ? "hide history" : "history"}
                    </button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Async>
      </Panel>

      {sku ? (
        <Panel title={`Movement history -- ${sku}`}
               note="Append-only. A correction is a compensating row, never an edit.">
          <Async
            state={moves.state}
            revalidating={moves.revalidating}
            onRetry={() => void moves.reload()}
            empty={<Empty>No movements recorded for {sku}.</Empty>}
          >
            {(d) => d.movements.length === 0 ? null : (
              <Table head={["#", "Type", "Qty", "Unit cost", "Booked value", "Source", "Entry", "When"]}>
                {d.movements.map((m) => (
                  <tr key={m.id}>
                    <td><code>{m.id}</code></td>
                    <td><Pill>{m.movement_type}</Pill></td>
                    <td className={Number(m.qty_delta) < 0 ? "cell-neg" : ""}>
                      <Num v={m.qty_delta} />
                    </td>
                    <td><Num v={m.unit_cost} /></td>
                    <td><Num v={m.booked_value} /></td>
                    <td>{m.source_doc} #{m.source_doc_id}</td>
                    {/* Every movement cites the entry that books it: ledger_entry_id is NOT NULL. */}
                    <td><code>{m.ledger_entry_id}</code></td>
                    <td className="muted">{new Date(m.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Async>
        </Panel>
      ) : null}
    </>
  );
}

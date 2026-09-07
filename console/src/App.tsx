import { useState } from "react";
import type { Reconciliation, Whoami } from "./api/types.js";
import { useResource } from "./hooks/useResource.js";
import { useHashRoute } from "./hooks/useHashRoute.js";
import { Async, ErrorBanner, Skeleton } from "./components/Async.jsx";
import { PERSONAS, can, loadToken, saveToken } from "./session.js";
import { Warehouse } from "./views/Warehouse.jsx";
import { Procurement } from "./views/Procurement.jsx";
import { Sales } from "./views/Sales.jsx";
import { Finance } from "./views/Finance.jsx";

/** A view is offered only if the actor holds the permission its data needs.
 *  This is presentation, not enforcement -- the server refuses regardless, and
 *  tests/rbac.test.ts calls a hidden endpoint directly to prove it. */
const VIEWS = [
  { id: "warehouse",   label: "Warehouse",   needs: "inventory.read" },
  { id: "procurement", label: "Procurement", needs: "po.read" },
  { id: "sales",       label: "Sales",       needs: "so.read" },
  { id: "finance",     label: "Finance",     needs: "ledger.read" },
] as const;

export function App() {
  const [token, setToken] = useState(loadToken);
  const [route, navigate] = useHashRoute("warehouse");
  const me = useResource<Whoami>("/whoami", token);

  const switchTo = (next: string) => {
    saveToken(next);
    setToken(next);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Northwind Operations Console</h1>
          <p className="sub">Live against the Stage 2 API. No mocked data anywhere.</p>
        </div>
        <label className="persona">
          Acting as
          <select value={token} onChange={(e) => switchTo(e.target.value)}>
            {PERSONAS.map((p) => (
              <option key={p.token} value={p.token}>{p.label}</option>
            ))}
          </select>
        </label>
      </header>

      {me.state.status === "loading" ? <Skeleton /> : null}
      {me.state.status === "error" ? (
        <ErrorBanner error={me.state.error} onRetry={() => void me.reload()} />
      ) : null}

      {me.state.data ? (
        <Console me={me.state.data} token={token} route={route} navigate={navigate} />
      ) : null}
    </div>
  );
}

function Console(
  { me, token, route, navigate }:
  { me: Whoami; token: string; route: string; navigate: (r: string) => void },
) {
  const allowed = VIEWS.filter((v) => can(me, v.needs));
  const current = allowed.find((v) => v.id === route) ?? allowed[0];

  return (
    <>
      <div className="identity" data-testid="identity">
        <span><strong>{me.email}</strong> — {me.roles.join(", ") || "no roles"}</span>
        <details>
          <summary>{me.permissions.length} permissions</summary>
          <ul className="perms">
            {me.permissions.map((p) => <li key={p}><code>{p}</code></li>)}
          </ul>
        </details>
        {can(me, "ledger.read") ? <ReconciliationBadge token={token} /> : null}
      </div>

      <nav className="tabs" data-testid="tabs">
        {VIEWS.map((v) => {
          const permitted = can(me, v.needs);
          return (
            <button
              key={v.id}
              type="button"
              className={current?.id === v.id ? "tab tab-active" : "tab"}
              disabled={!permitted}
              // Naming the missing permission is more useful than a dead tab.
              title={permitted ? undefined : `requires ${v.needs}`}
              onClick={() => navigate(v.id)}
            >
              {v.label}
              {permitted ? null : <span className="tag">locked</span>}
            </button>
          );
        })}
      </nav>

      <main>
        {!current ? (
          <p className="empty">
            This role holds none of the permissions the four views need. Switch persona above.
          </p>
        ) : current.id === "warehouse" ? <Warehouse me={me} token={token} />
          : current.id === "procurement" ? <Procurement me={me} token={token} />
          : current.id === "sales" ? <Sales me={me} token={token} />
          : <Finance me={me} token={token} />}
      </main>
    </>
  );
}

/** Requirement 4: the reconciliation verdict is visible from every view, not
 *  buried in Finance, because it is the one figure that says whether anything
 *  else on screen can be trusted. */
function ReconciliationBadge({ token }: { token: string }) {
  const r = useResource<Reconciliation>("/reports/inventory-reconciliation", token,
    { pollMs: 10000 });
  return (
    <Async state={r.state} onRetry={() => void r.reload()}>
      {(d) => (
        <span data-testid="recon-badge"
              className={`badge badge-${d.status === "TIES" ? "ok" : "bad"}`}
              title={`subledger ${d.subledger_value} vs GL 1300 ${d.gl_inventory_value}`}>
          ledger matches inventory: {d.status === "TIES" ? "yes" : "no"}
          <span className="badge-delta">delta {d.delta}</span>
        </span>
      )}
    </Async>
  );
}

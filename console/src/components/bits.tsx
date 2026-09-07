import type { ReactNode } from "react";

/** Right-aligned, tabular, and never reformatted -- the API already rounded it. */
export const Num = ({ v, unit }: { v: string; unit?: string }) => (
  <span className="num">{v}{unit ? <span className="unit">{unit}</span> : null}</span>
);

export const Money = ({ v }: { v: string }) => (
  <span className="num">{Number(v) < 0 ? "" : " "}{v}</span>
);

const TONE: Record<string, string> = {
  TIES: "ok", DRIFT: "bad",
  OPEN: "info", BACKORDERED: "warn", FULFILLED: "ok",
  DRAFT: "info", CONFIRMED: "info", PARTIALLY_FULFILLED: "warn", CANCELLED: "muted",
  PENDING_APPROVAL: "warn", APPROVED: "info", RECEIVING: "warn", CLOSED: "ok",
  GOODS_RECEIPT: "ok", SALES_ISSUE: "warn", ADJUSTMENT: "info",
  TRANSFER_IN: "info", TRANSFER_OUT: "info",
};

export const Pill = ({ children }: { children: string }) => (
  <span className={`pill pill-${TONE[children] ?? "info"}`}>{children.replace(/_/g, " ")}</span>
);

export function Panel(
  { title, actions, children, note }:
  { title: string; actions?: ReactNode; children: ReactNode; note?: ReactNode },
) {
  return (
    <section className="panel">
      <header>
        <h2>{title}</h2>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      {note ? <p className="note">{note}</p> : null}
      {children}
    </section>
  );
}

export function Table(
  { head, children }: { head: readonly string[]; children: ReactNode },
) {
  return (
    <div className="table-scroll">
      <table>
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Shown in place of a control the actor's role cannot use. Explaining the
 *  absence is more useful than a blank space, and it makes the RBAC visible. */
export const Locked = ({ permission }: { permission: string }) => (
  <p className="locked">Your role does not hold <code>{permission}</code>, so this
    action is hidden. The server would refuse it regardless.</p>
);

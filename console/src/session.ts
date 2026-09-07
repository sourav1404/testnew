import type { Whoami } from "./api/types.js";

/**
 * Stage 2's bearer token is an email address -- a deliberate stand-in for a
 * real identity provider. The console keeps that shape rather than inventing a
 * login it cannot honour, and makes the role switch explicit so a reviewer can
 * watch the surface area change.
 *
 * The important property: the console never decides what a role may do. It asks
 * /whoami and renders what comes back. Hiding a button is presentation; the
 * server is the authority, and tests/rbac.test.ts calls a hidden endpoint
 * directly to prove the 403 is real rather than cosmetic.
 */
export interface Persona {
  token: string;
  label: string;
  /** Only for the switcher's own description -- never used for a decision. */
  blurb: string;
}

export const PERSONAS: readonly Persona[] = [
  { token: "wh@nw.test",    label: "Wes -- warehouse operator",
    blurb: "receives goods, adjusts stock" },
  { token: "whsup@nw.test", label: "Sam -- warehouse supervisor",
    blurb: "warehouse plus authority to accept an over-receipt" },
  { token: "agent@nw.test", label: "Ada -- purchasing agent",
    blurb: "raises purchase orders, cannot approve one" },
  { token: "manager@nw.test", label: "Mo -- purchasing manager",
    blurb: "approves purchase orders up to a limit" },
  { token: "sales@nw.test", label: "Sal -- sales rep",
    blurb: "raises and confirms sales orders" },
  { token: "ship@nw.test",  label: "Shay -- fulfilment operator",
    blurb: "ships confirmed orders, runs the expiry sweep" },
  { token: "acct@nw.test",  label: "Ana -- accountant",
    blurb: "journals, reconciliation, period close" },
  { token: "audit@nw.test", label: "Avi -- auditor",
    blurb: "reads everything, writes nothing" },
];

const STORAGE_KEY = "northwind.token";

export function loadToken(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && PERSONAS.some((p) => p.token === stored)) return stored;
  } catch {
    // Private mode, or storage disabled. Fall through to the default.
  }
  return PERSONAS[0]!.token;
}

export function saveToken(token: string): void {
  try { window.localStorage.setItem(STORAGE_KEY, token); } catch { /* not fatal */ }
}

export const can = (me: Whoami | null, permission: string): boolean =>
  me?.permissions.includes(permission) ?? false;

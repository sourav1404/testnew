# Northwind Operations Console -- Frontend (Stage 3)

Four operator views over the Stage 2 API. React 18, Vite, TypeScript strict.
No component library, no data-fetching library, no state manager -- 2,102 lines
of which every line is inspectable. 15 Playwright tests and 8 unit tests, all
green against the live backend.

    # terminal 1 -- the Stage 2 backend
    cd .. && npm run migrate && npm run seed && npm start

    # terminal 2 -- the console
    npm install && npm run dev          # http://localhost:5174
    npm run typecheck && npm test       # unit
    npx playwright test                 # 15 browser tests against the live API

## The decision that shapes everything: no cache, no optimism

The brief asks for two things that a normal client cache actively fights:
a fresh page load must reflect true backend state, and availability at
sales-order time must be live. So this console has no normalised cache and no
optimistic updates. `useResource` is the whole of its server-state layer:

- every mount fetches;
- a mutation calls `reload()` rather than patching local state;
- regaining window focus revalidates, because the operator has probably been in
  another tab or another session;
- contended views poll (availability every 3s, warehouse 4s, reconciliation 10s).

Optimism is the tempting part to add and the wrong thing here. The contended
case *is* the last unit: an optimistic "reserved!" would be a lie exactly when
it matters, because the server may have just given that unit to someone else.
A 300ms wait for the truth is cheaper than a promise the warehouse cannot keep.

The cost is more requests. For a screen whose entire job is to tell an operator
whether stock is actually there, that is the right trade, and it is a trade
rather than an oversight.

## Requirement 2, measured

`e2e/concurrency.spec.ts`, through a real browser:

    [live] on screen before: 3.0000
    [live] on screen after another session reserved 2: 1.0000
    [live] after a full page reload: still 1.0000

    [two sessions] watcher sees 2.0000 available
    [two sessions] buyer confirmed 2 through the UI
    [two sessions] watcher now sees 0.0000 available, without touching anything

The first case has a second, non-browser session reserve two units; the page
was not touched, reloaded or clicked. The reload afterwards is the point of the
third line: it proves what we saw was the server's number, not a local patch
that happened to look right.

The second case is two separate browser contexts -- separate localStorage,
separate personas. The buyer drives the real UI (create, confirm); the watcher
is on the Warehouse view and sees availability fall to zero on its own.

## Role-based surface

Nav, buttons and the reconciliation badge all come from `/whoami`. The console
never decides what a role may do; it renders what the server says it holds.

    [rbac] sales tabs:      Warehouse Procurement[locked] Sales Finance[locked]
    [rbac] accountant tabs: Warehouse Procurement[locked] Sales[locked] Finance
    [rbac] accountant badge: ledger matches inventory: yes  delta 0.00
    [rbac] both hidden actions return 403 when called directly

That last line matters more than the first two. Hiding a control is
presentation; `e2e/rbac.spec.ts` calls the endpoints behind the hidden controls
directly and asserts the 403, so the UI is never mistaken for the enforcement.
Where a control is hidden, the console names the missing permission rather than
leaving a gap -- an operator who cannot do something should know why.

## States

Every view goes through one `<Async>` component, so loading, empty, error and
stale-but-readable are decided in one place instead of each view inventing a
spinner:

    [empty]   No stock anywhere yet. Receive against a purchase order first.
    [loading] skeleton visible while the request is in flight
    [offline] Network unreachable -- cannot reach the API at http://localhost:3000.
              Is the Stage 2 backend running?
    [404]     Not found -- purchase order 999999 not found
    [409]     Nothing to ship -- sales order 4 has no live reservation to ship
    [error]   Over receipt (422) -- Ordered 10.0000  Already received 0  Attempted 12
              Reason: resubmit with allow_over_receipt to accept it as an over-receipt

Two deliberate choices there. First, the error banner shows the server's own
message and its detail payload: the backend already knows the arithmetic, and
"Request failed" would throw away the only part the operator needs. Second, an
error arriving over data already on screen keeps the data and marks it stale,
rather than blanking a table someone was reading because one poll failed.

## What the console computes, and why

Almost nothing -- with one exception, which is the interesting part.

The API's `backordered_qty` is `qty - fulfilled_qty`, so it counts *held* stock
as backordered, and `line_status` stays `OPEN` until something ships. Neither is
what an operator needs. A test asserting `BACKORDERED` on an order with 5 held
and 3 uncovered failed, and it was right to: the backend says `OPEN`.

So the Sales view shows the decomposition and computes the figure itself:

    [partial] line: E2E-C  WH1  ordered 8.0000  held 5.0000  shipped 0.0000
                    uncovered 3.0000  unshipped(API) 8.0000  status(API) OPEN

`Uncovered = ordered - shipped - held` is the part with no stock behind it.
Both columns are labelled for what they are rather than quietly conflated, and
the footnote says the two differ while a reservation is live. `uncoveredQty`
does that subtraction on the numeric(14,4) strings with BigInt, because the
backend keeps them as strings precisely so a unit cannot round away -- parsing
them to floats here would undo a fix the backend spent a whole round making.
Eight unit tests cover it, including `0.3 - 0.1 - 0.1`, which float gets wrong.

## Structure

    src/api/client.ts      fetch wrapper; ApiError keeps status, code and detail
    src/api/types.ts       response shapes; money and quantities stay strings
    src/session.ts         personas, and `can()` -- the only permission read
    src/hooks/useResource  server state: fetch, poll, focus-revalidate, reload
    src/hooks/useHashRoute 20 lines instead of a router: four views, no nesting
    src/components/Async   loading / empty / error / stale, in one place
    src/components/bits    Panel, Table, Pill, Num, Locked
    src/views/*.tsx        Warehouse, Procurement, Sales, Finance
    e2e/*.spec.ts          15 browser tests against the live backend

## Backend changes this stage needed

- **CORS.** `src/cors.ts` in the backend, hand-rolled: an explicit origin
  allow-list, `idempotency-key` in allow-headers (or the browser strips the one
  header that makes a retried receipt safe), `Idempotent-Replay` in
  expose-headers (or the console cannot tell a fresh 201 from a replay), and the
  preflight answered before `authenticate()`, since an OPTIONS request carries
  no Authorization header and would otherwise 401.
- **Open a sales order by id.** A fulfilment operator holds `so.fulfil` but not
  `so.create`, so with only the create-then-show flow the role could not do its
  job at all. Found by writing the test for it.

## Assumptions

- **The bearer token is an email address**, as in Stage 2. The persona switcher
  is explicit rather than a fake login, because inventing a login this backend
  cannot honour would be the mocking the brief rules out.
- **One customer and one supplier** (`CUST-1`, `SUP-1`) are hard-coded in the
  create forms. Stage 2 has no endpoint that lists or creates either, so a
  picker would have to invent data. Named here rather than hidden.
- **Warehouses are a two-option select** (`WH1`, `WH2`) for the same reason.
- **Money and quantities are never parsed for display.** The API rounded them
  already; re-rounding in the browser is how a UI and its backend start
  disagreeing about a total.
- **Polling, not websockets.** The backend has no push channel, and adding one
  for four screens would be a larger change to Stage 2 than the problem needs.
- **No product creation.** The API has no endpoint for it; `e2e/global-setup.ts`
  inserts e2e products directly and says so. Everything else in the tests goes
  through the API.

## Honest limits

- **Polling is a floor on staleness, not zero.** Availability can be up to ~3s
  old. For a warehouse console that is fine; for a checkout funnel it would not
  be, and the answer there is a push channel rather than a shorter interval.
- **No virtualisation.** The tables render every row. Fine for the seeded data,
  wrong for a real catalogue.
- **The Sales view holds one order at a time.** There is no order list, because
  Stage 2 has no list endpoint -- only `GET /sales-orders/:id`.
- **`aria-live` only on the loading and revalidating states.** A screen reader
  is not told when a polled figure changes underneath the user, which for a
  number that drives a decision is a real gap.
- **No retry/backoff on a failed poll.** The next interval simply tries again,
  so a flapping backend produces a flapping banner.

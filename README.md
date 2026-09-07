# Northwind Mini-ERP — Backend (Stage 2)

Inventory, Procurement, Sales fulfilment and a Financial Ledger as one service
over one PostgreSQL database. TypeScript, Express, `pg`, no ORM.

    npm install
    docker run -d --name erp-pg -p 55432:5432 -e POSTGRES_PASSWORD=erp postgres:16
    createdb northwind            # or: psql -c 'CREATE DATABASE northwind'
    npm run migrate && npm run seed
    npm test                      # 51 tests
    npm start                     # :3000

`npm run verify` does migrate → seed → typecheck → test in one go.
`./scripts/mutation-check.sh` breaks each safety mechanism in turn and checks
that the suite notices.

## The decision that shapes everything

One database, one transaction per business event. Not four services.

The brief's defining requirement is that a goods receipt or a fulfilment
produces a correct record *across* module boundaries. That is a demand for
atomicity between inventory and the ledger. Split them and the movement and its
journal entry land in different stores, so you need a saga with compensating
entries: the books are deliberately wrong for a window, and permanently wrong
the first time a compensation fails. For one finance team that is a lot of
machinery bought in exchange for weakening the one guarantee they care about.

So: a modular monolith. Each module owns its tables (`src/modules/*.ts`), and
cross-module writes go through `postEntry()` rather than another module's SQL.
Every service function takes a `Tx` rather than reaching for the pool, so a
caller cannot accidentally split one event across two transactions.

## Where each rule lives

Invariants that must hold no matter which code path runs are constraints and
triggers. Rules that need a lock, a decision, or a good error message are in the
service layer, where they are visible.

| Rule | Enforced by |
|---|---|
| Stock never goes negative | `no_oversell` CHECK — the backstop |
| Reservation is safe under load | `SELECT … FOR UPDATE` in `confirmSalesOrder` |
| A movement always has a journal entry | `ledger_entry_id NOT NULL` |
| The entry books what the movement books | `movement_ties_to_ledger` (deferred) |
| Every entry balances, ≥ 2 lines | `ledger_entry_complete` (deferred) |
| Posted entries are immutable | `BEFORE UPDATE OR DELETE` triggers |
| A reversal exactly mirrors its original | `reversal_mirrors_original` (deferred) |
| No manual journal into a control account | `guard_ledger_line` |
| Over-receipt is explicit | service pre-check + `check_over_receipt` |
| Maker ≠ checker; within limit | `po_maker_checker`, `po_within_limit` CHECKs |
| Roles that conflict cannot be co-held | `incompatible_roles` + trigger |
| API authorisation | `requirePermission` middleware, per route |

Stage 1 claimed several of these in prose. Every rule in that table now has a
test that attempts a real violation and asserts the refusal -- an audit part-way
through this stage found that sentence was not yet true, because several
invariants had never been made to reject anything. `tests/invariants.test.ts`
covers the thirteen that were missing. §"Honest limits" still says what is
unproven.

## What changed from the Stage 1 design, and why

All four changes were forced by building it, not by taste.

1. **`apply_movement()` rewritten.** Stage 1 proposed the incoming `qty_delta`
   as the *inserted* `on_hand_qty` and relied on `ON CONFLICT DO UPDATE` for the
   arithmetic. Postgres runs `ExecConstraints` on the proposed tuple **before**
   it discovers the conflict, so `no_oversell` saw a negative `on_hand_qty` on
   every issue: **no `SALES_ISSUE` could succeed at any stock level.** Fulfilment
   was unreachable. The row is now materialised neutrally and all arithmetic
   happens in the `UPDATE`, so the constraint only sees the true post-state.
2. **`sales_order_lines.fulfilled_qty` added.** `so_status` had
   `PARTIALLY_FULFILLED`, but nothing could represent it — `stock_movements` has
   no line reference and its `source_doc_id` points at the order. Backordered
   quantity is now derived (`sales_order_line_status`), never stored.
3. **`check_over_receipt()` locks the PO line `FOR UPDATE`.** Stage 1 admitted
   this gap in writing and left it open.
4. **`idempotency_keys` keyed on `(endpoint, key)` with a request hash.** Stage 1
   keyed on the key alone, so one key reused across two endpoints replayed the
   first endpoint's response.

## API

    GET  /health                                    -- unauthenticated
    GET  /whoami                                    -- roles and permissions
    GET  /inventory/availability?sku&warehouse      inventory.read
    GET  /inventory/movements?sku                   inventory.read
    POST /inventory/adjustments                     inventory.adjust
    POST /purchase-orders                           po.create
    POST /purchase-orders/:id/approve               po.approve
    GET  /purchase-orders/:id                       po.read
    POST /purchase-orders/:id/goods-receipts        receipt.create (+ receipt.over_receive)
    POST /sales-orders                              so.create
    POST /sales-orders/:id/confirm                  so.confirm
    POST /sales-orders/:id/fulfil                   so.fulfil
    GET  /sales-orders/:id                          so.read
    POST /reservations/expire                       so.fulfil
    GET  /ledger/trial-balance?as_of                ledger.read
    GET  /reports/inventory-reconciliation?as_of    ledger.read
    POST /ledger/entries                            ledger.post_manual
    POST /ledger/entries/:id/reverse                ledger.reverse

Auth is `Authorization: Bearer <email>` — a deliberate stand-in for a real
identity provider, so tests can assume a role without a login flow. The roles
and permissions behind it are real, read from the database on every request.

## What every event posts

| Event | Movement | Journal |
|---|---|---|
| Goods receipt (partial ok) | +qty @ PO price | DR 1300 / CR 2100 |
| Fulfilment — cost | −qty @ moving average | DR 5000 / CR 1300 |
| Fulfilment — revenue | none | DR 1200 / CR 4000 |
| Stock adjustment | ±qty @ moving average | DR/CR 1300 vs 5900 |
| Reservation held/released/expired | none | none — no economic event |
| PO approval, cancellation | none | none — no goods, no obligation |

A reservation is not a stock movement: nothing has moved, so nothing is posted.

## Assumptions

Stated because the brief is underspecified on purpose.

- **Single currency, one legal entity.** No FX, no intercompany.
- **Costing is moving weighted average.** FIFO would value COGS more faithfully
  but needs cost layers and a consumption order; that is a deliberate cut.
- **"Manufacturing" is treated as trading.** No BOM or routing was specified.
- **Over-receipt tolerance is zero** unless a caller with `receipt.over_receive`
  explicitly asks. The excess then shows as negative `outstanding_qty` rather
  than being absorbed.
- **A confirmed order reserves what exists and backorders the rest**, rather
  than refusing the whole order because one line is short.
- **Reservations expire on a TTL** (default 15 min) and are swept by
  `POST /reservations/expire`, which a scheduler calls. No in-process timer.
- **Prices exclude tax.** There is a rate field's worth of room, no tax engine.
- **`admin` is deliberately not a superuser.** If whoever grants roles can also
  approve their own purchase order, every other rule here is decoration.
- **Warehouses have no bin locations.**
- Correcting a *goods receipt* is a compensating inventory adjustment, not a
  ledger reversal — see the guard in `reverseEntry`.

## Test evidence

51 tests, all through HTTP against the real app or straight at the database
where the point is that the database refuses something.

    [concurrency] 12 requests, 3 units: winners=3 totalReserved=3 on_hand=3.0000 reserved=3.0000 available=0.0000
    [concurrency] 20 requests, 1 unit: winners=1 reserved=1.0000 available=0.0000
    [concurrency] opposite-order multi-line: statuses=200,200 deadlocks=0
    [backstop] direct insert refused: no_oversell
    [procurement] received 40 -> outstanding 60.0000, PO RECEIVING
    [procurement] received 35 -> outstanding 25.0000, PO RECEIVING
    [procurement] received 25 -> outstanding 0.0000, PO CLOSED
    [procurement] ordered 10, had 7, tried 5 -> 422 over_receipt
    [procurement] flagged over-receipt: received=12.0000 outstanding=-2.0000 is_over_received=true
    [procurement] concurrent 6+6 on a 10 line: accepted=1 rejected=1 received=6.0000
    [fulfil] order 8 against 5 on hand -> reserved=5.0000 backordered=3.0000
    [fulfil] first shipment: status=PARTIALLY_FULFILLED shipped=5.0000 cogs=50.00 backordered=3.0000
    [fulfil] second shipment: status=FULFILLED shipped=3.0000 unit_cost=20.0000
    [fulfil] sweep expired=1 -> available=1.0000
    [ledger] delta=0.00 unbalanced=0 status=TIES          (subledger == gl_1300)
    [ledger] trial balance total=0.00 across 8 accounts
    [ledger] UPDATE on entry 1 -> ERP02: ledger_entries is append-only
    [ledger] double reversal -> 409 already_reversed
    [ledger] reversing a goods-receipt entry -> 409 reversal_would_break_reconciliation
    [rbac] no token -> 401 unauthenticated
    [rbac] warehouse_operator -> POST /purchase-orders/1/approve = 403 (requires po.approve)
    [rbac] operator over-receipt -> 422 (requires the receipt.over_receive permission)
    [rbac] supervisor over-receipt -> 201 over_receipt=true
    [rbac] self-approval refused by po_maker_checker
    [invariant] 72,000 on a 50,000 limit -> 403 approval_limit_exceeded
    [invariant] refused by ERP07: movement 1 books 12.50 but entry 1 posts 99.00 to Inventory
    [invariant] refused by ERP06: entry 3 does not exactly reverse entry 2
    [invariant] refused by ERP09: stock_balances is a projection
    [invariant] refused by ERP08: reservation 1 is CONSUMED; terminal states cannot be revived
    [invariant] refused by ERP11: PO is approved; its value cannot change
    [invariant] posting into closed 2026-08-01 -> 409 period_closed
    [invariant] refused by one_live_hold_per_line, res_expiry_sane,
                movement_sign_matches_type, sol_not_over_fulfilled, ERP02

The reconciliation *total* is deliberately not quoted: node:test runs the files
concurrently, so the figure depends on which other tests have committed at that
instant. Across four consecutive full runs it was 653.50, 517.50, 605.50 and
1252.50 -- and `delta` was `0.00` with `status=TIES` every time. The equality is
the invariant; the total is not. Four runs, 51/51, no flakes.

### Is the suite actually load-bearing?

A test that has never failed is not evidence, so `scripts/mutation-check.sh`
breaks one mechanism at a time and checks the suite goes red. Six of eight
mutations are caught. **Two survive, and the script says so rather than hiding
it:**

- **Removing the service-level `FOR UPDATE` on the PO line.** Correctness here
  actually comes from `check_over_receipt()`, which takes its own lock. Without
  the service lock two callers can both pass the pre-check and the trigger
  rejects the second — the final state is still right, so no black-box test can
  separate the two. The service lock is kept because it turns that into a clean
  422 carrying the arithmetic instead of a wasted transaction and a bare
  constraint error.
- **Removing `SET CONSTRAINTS ALL IMMEDIATE`.** The deferred trigger then fires
  during `COMMIT`; `withTx` still rolls back and the error still maps to the
  same 422. Kept because it raises the failure where a caller could still handle
  it, not because a test proves it.

Finding these is the reason the script exists. Before it, I would have claimed
the PO-line lock was what made concurrent receipts safe.

## Honest limits

- **`as_of` reconciliation now filters both sides by the entry's accounting
  date.** It previously filtered movements by their physical `created_at` and
  the ledger by `entry_date`; the two agree in normal operation, but a movement
  written just after midnight against an entry dated the previous day would land
  on opposite sides of the cutoff and manufacture a delta that does not exist.
- **Contention, not throughput.** Every reserver for one SKU serialises on one
  `stock_balances` row, and `sync_reserved()` rewrites it with an `O(holds)`
  `SUM` each time. Correctness under contention is measured; throughput is not.
- **`avg_unit_cost` cannot be rebuilt from the movements alone.** Replaying them
  gives the same average only in the original order. Storing a running average
  per movement would make it auditable; not done.
- **`idempotency_keys` exists but no route uses it yet.** The table and its key
  shape are right; wiring it into the mutating routes is not done, so a retried
  `POST /goods-receipts` will receive twice.
- **The bearer token is an email address.** Fine for this stage, not an auth
  system.
- **No returns/credit notes.** The highest-value omission and the first thing I
  would build: it is the reverse of fulfilment on the same machinery.
- **RBAC is permission-per-route.** Row-level scoping (this warehouse, this
  customer) is not modelled; Postgres RLS is where that would go.

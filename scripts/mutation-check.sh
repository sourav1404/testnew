#!/usr/bin/env bash
# Proves the test suite is load-bearing rather than decorative. A check that has
# never failed is not evidence, so each mutation below breaks exactly one safety
# mechanism and the suite must go red for every single one.
#
# Restore copies a saved snapshot back over the file. Nothing is ever removed,
# and an EXIT trap puts every touched file back even if a run is interrupted.
set -uo pipefail
cd "$(dirname "$0")/.."

SNAP=$(mktemp -d)
TOUCHED=()
snapshot() {
  local f="$1" key="${1//\//_}"
  if [ ! -f "$SNAP/$key" ]; then cp "$f" "$SNAP/$key"; TOUCHED+=("$f"); fi
}
restore_all() {
  local f key
  for f in "${TOUCHED[@]:-}"; do
    [ -n "$f" ] || continue
    key="${f//\//_}"
    [ -f "$SNAP/$key" ] && cp "$SNAP/$key" "$f"
  done
}
trap restore_all EXIT

reset_db() { npm run migrate --silent >/dev/null 2>&1 && npm run seed --silent >/dev/null 2>&1; }

fail=0
mutate() {
  local name="$1" file="$2" from="$3" to="$4" test_file="$5"
  restore_all
  snapshot "$file"
  if ! grep -qF -- "$from" "$file"; then
    echo "STALE     $name -- pattern no longer in $file, so the mutation proves nothing"
    fail=$((fail+1)); return
  fi
  python3 -c '
import sys
path, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
assert a in s, "anchor missing"
open(path, "w").write(s.replace(a, b, 1))
' "$file" "$from" "$to"
  reset_db
  if npx tsx --test "$test_file" >/dev/null 2>&1; then
    echo "SURVIVED  $name -- $test_file did NOT catch it"
    fail=$((fail+1))
  else
    echo "caught    $name"
  fi
  restore_all
}

# Some mutations cannot be caught from outside the process, and pretending
# otherwise would be worse than saying so. Declaring one here pins the fact in
# both directions: if it ever starts being caught, this script fails and the
# comment has to be revisited.
expect_survivor() {
  local name="$1" file="$2" from="$3" to="$4" test_file="$5" why="$6"
  restore_all
  snapshot "$file"
  if ! grep -qF -- "$from" "$file"; then
    echo "STALE     $name -- pattern no longer in $file"; fail=$((fail+1)); return
  fi
  python3 -c '
import sys
path, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
assert a in s, "anchor missing"
open(path, "w").write(s.replace(a, b, 1))
' "$file" "$from" "$to"
  reset_db
  if npx tsx --test "$test_file" >/dev/null 2>&1; then
    echo "known gap $name -- not observable: $why"
  else
    echo "NOW CAUGHT $name -- it is observable after all; drop the expectation"
    fail=$((fail+1))
  fi
  restore_all
}

echo "baseline: the suite must be green first, or nothing below means anything"
reset_db
if ! npm test >/dev/null 2>&1; then
  echo "ABORT: baseline is red; mutation results would be meaningless"; exit 1
fi
echo "baseline green"
echo

mutate "reservation row lock removed" src/modules/sales.ts \
  "      ORDER BY b.product_id, b.warehouse_id
      FOR UPDATE\`, [soId]);

  // Read availability only now" \
  "      ORDER BY b.product_id, b.warehouse_id\`, [soId]);

  // Read availability only now" \
  tests/concurrency.test.ts

mutate "reservation ignores availability" src/modules/sales.ts \
  "const take = Math.min(outstanding, Number(line.available));" \
  "const take = outstanding;" \
  tests/concurrency.test.ts

mutate "over-receipt check disabled" src/modules/procurement.ts \
  "if (isOver && !(line.allowOverReceipt && input.mayOverReceive)) {" \
  "if (false) {" \
  tests/procurement.test.ts

expect_survivor "PO line lock downgraded" src/modules/procurement.ts \
  "      FOR UPDATE OF l\`, [ids, input.poId]);" \
  "\`, [ids, input.poId]);" \
  tests/procurement.test.ts \
  "correctness here comes from check_over_receipt(), which takes its own FOR UPDATE on the PO line. Without the service lock two callers can both pass the pre-check and the trigger rejects the second, so the final state is still right and no black-box test can separate the two. The service lock is kept because it turns that into a clean 422 with the arithmetic instead of a wasted transaction and a bare constraint error"

mutate "permission check bypassed" src/auth.ts \
  "if (!actor.permissions.has(permission)) {" \
  "if (false) {" \
  tests/rbac.test.ts

mutate "over-receipt permission ignored" src/app.ts \
  "mayOverReceive: actor.permissions.has(\"receipt.over_receive\")," \
  "mayOverReceive: true," \
  tests/rbac.test.ts

mutate "ledger reversal guard removed" src/modules/ledger.ts \
  "if (Number(backed.rows[0]!.n) > 0) {" \
  "if (false) {" \
  tests/ledger.test.ts

expect_survivor "deferred constraints left until COMMIT" src/db.ts \
  "await client.query(\"SET CONSTRAINTS ALL IMMEDIATE\");" \
  "" \
  tests/ledger.test.ts \
  "without it the deferred trigger fires during COMMIT instead; withTx still rolls back and the error still maps to the same 422, so no HTTP-level test can tell the difference. The line is kept because it raises the failure where a caller could still handle it, not because a test proves it"

mutate "idempotency replay check removed" src/idempotency.ts \
  "    if (claim.rowCount === 0) {" \
  "    if (false) {" \
  tests/idempotency.test.ts

mutate "idempotency request-hash check removed" src/idempotency.ts \
  "      if (row.request_hash !== requestHash) {" \
  "      if (false) {" \
  tests/idempotency.test.ts

mutate "unknown sku/warehouse no longer rejected" src/modules/inventory.ts \
  "  if (!row) throw new ApiError(422, \"unknown_reference\", \`unknown sku/warehouse \${sku}/\${warehouse}\`);" \
  "  if (!row) return { productId: 1, warehouseId: 1 };" \
  tests/validation.test.ts

mutate "constraint errors fall through to 500 again" src/errors.ts \
  "  if (code.startsWith(\"23\")) {" \
  "  if (false) {" \
  tests/validation.test.ts

mutate "empty sales order accepted again" src/modules/sales.ts \
  "  if (input.lines.length === 0) {" \
  "  if (false) {" \
  tests/validation.test.ts

mutate "money arithmetic back to float" src/money.ts \
  "    return unscale(scaled(a, field) * scaled(b, field) / WORK_SCALE, dp);" \
  "    return (Number(a) * Number(b)).toFixed(dp);" \
  tests/precision.test.ts

mutate "idempotency hash no longer canonical" src/idempotency.ts \
  "  if (Array.isArray(v)) return \`[\${v.map(canonical).join(\",\")}]\`;" \
  "  return JSON.stringify(v);" \
  tests/idempotency.test.ts

mutate "abandoned-claim reclaim removed" src/idempotency.ts \
  "        WHERE idempotency_keys.response_code = 0" \
  "        WHERE false AND idempotency_keys.response_code = 0" \
  tests/idempotency.test.ts

mutate "confirmation actor no longer recorded" src/modules/sales.ts \
  "        SET status = 'CONFIRMED', confirmed_by = \$2, confirmed_at = now()" \
  "        SET status = 'CONFIRMED', confirmed_by = created_by, confirmed_at = now()" \
  tests/precision.test.ts

mutate "idempotency key purge disabled" src/idempotency.ts \
  "    \`DELETE FROM idempotency_keys WHERE created_at < now() - \$1::interval\`," \
  "    \`SELECT 1 WHERE created_at IS NULL AND \$1::interval IS NOT NULL\`," \
  tests/idempotency.test.ts

echo
if [ "$fail" -ne 0 ]; then
  echo "RESULT: $fail mutation(s) survived or went stale -- the suite is not proving what it claims"
  exit 1
fi
echo "RESULT: 16 mutations caught, 2 declared unobservable and holding"

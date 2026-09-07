-- Northwind Mini-ERP -- schema
--
-- Revised from the Stage 1 design. Changes and why, all four forced by
-- building against a real database rather than by taste:
--
--  1. apply_movement() no longer proposes the raw qty_delta as the inserted
--     on_hand_qty. Postgres runs ExecConstraints on the proposed tuple BEFORE
--     it takes the ON CONFLICT DO UPDATE branch, so no_oversell fired on every
--     negative movement: on the Stage 1 schema no SALES_ISSUE could ever
--     succeed at any stock level. Fulfilment was literally unreachable.
--  2. sales_order_lines.fulfilled_qty added. so_status had PARTIALLY_FULFILLED
--     but nothing could represent it -- stock_movements has no line reference
--     and its source_doc_id points at the order.
--  3. check_over_receipt() now locks the PO line FOR UPDATE. Stage 1 admitted
--     this gap in writing and did not close it; two concurrent receipts could
--     each see the other as absent.
--  4. idempotency_keys is keyed on (endpoint, key) with a request hash, so the
--     same key on two endpoints no longer returns the first one's response.

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  full_name  text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true
);
-- One human cannot hold two accounts, or maker-checker is decoration.
CREATE UNIQUE INDEX users_email_ci ON users (lower(email));

CREATE TABLE roles (
  code              text PRIMARY KEY,
  description       text NOT NULL,
  po_approval_limit numeric(14,2)
);

CREATE TABLE user_roles (
  user_id    bigint NOT NULL REFERENCES users(id),
  role_code  text   NOT NULL REFERENCES roles(code),
  granted_by bigint REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_code)
);

-- RBAC is data, not a switch statement. The API layer reads this table.
CREATE TABLE permissions (
  code        text PRIMARY KEY,
  description text NOT NULL
);
CREATE TABLE role_permissions (
  role_code       text NOT NULL REFERENCES roles(code),
  permission_code text NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE incompatible_roles (
  role_a text NOT NULL REFERENCES roles(code),
  role_b text NOT NULL REFERENCES roles(code),
  reason text NOT NULL,
  PRIMARY KEY (role_a, role_b)
);

CREATE FUNCTION enforce_role_exclusivity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE clash text;
BEGIN
  SELECT ir.reason INTO clash FROM incompatible_roles ir
    JOIN user_roles ur ON ur.user_id = NEW.user_id
   WHERE (ir.role_a = NEW.role_code AND ir.role_b = ur.role_code)
      OR (ir.role_b = NEW.role_code AND ir.role_a = ur.role_code)
   LIMIT 1;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'incompatible roles for user %: %', NEW.user_id, clash
      USING ERRCODE = 'ERP01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_roles_exclusivity BEFORE INSERT ON user_roles
  FOR EACH ROW EXECUTE FUNCTION enforce_role_exclusivity();

-- ---------------------------------------------------------------- masters
CREATE TABLE warehouses (
  id   bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL
);
CREATE TABLE products (
  id        bigserial PRIMARY KEY,
  sku       text NOT NULL UNIQUE,
  name      text NOT NULL,
  uom       text NOT NULL DEFAULT 'EA',
  is_active boolean NOT NULL DEFAULT true
  -- Deliberately no quantity_on_hand: stock is derived from movements.
);
CREATE TABLE suppliers (
  id bigserial PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE customers (
  id bigserial PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------- ledger
CREATE TABLE accounts (
  code       text PRIMARY KEY,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  is_control boolean NOT NULL DEFAULT false
);
CREATE TABLE accounting_periods (
  period    date PRIMARY KEY,
  status    text NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  closed_by bigint REFERENCES users(id),
  closed_at timestamptz
);

CREATE TABLE ledger_entries (
  id            bigserial PRIMARY KEY,
  entry_date    date NOT NULL,
  source_doc    text NOT NULL,
  source_doc_id bigint NOT NULL,
  memo          text,
  reverses_id   bigint REFERENCES ledger_entries(id),
  created_by    bigint NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (entry_date);
CREATE INDEX ON ledger_entries (source_doc, source_doc_id);
-- One entry may be reversed at most once.
CREATE UNIQUE INDEX one_reversal_per_entry
  ON ledger_entries (reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TABLE ledger_lines (
  id           bigserial PRIMARY KEY,
  entry_id     bigint NOT NULL REFERENCES ledger_entries(id),
  account_code text NOT NULL REFERENCES accounts(code),
  amount       numeric(14,2) NOT NULL CHECK (amount <> 0),  -- +DR, -CR
  product_id   bigint REFERENCES products(id),
  warehouse_id bigint REFERENCES warehouses(id)
);
CREATE INDEX ON ledger_lines (entry_id);
CREATE INDEX ON ledger_lines (account_code);
CREATE INDEX ON ledger_lines (product_id, warehouse_id);

-- Posted entries are immutable. Corrections are reversing entries.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; post a reversing entry instead', TG_TABLE_NAME
    USING ERRCODE = 'ERP02';
END $$;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_lines_append_only BEFORE UPDATE OR DELETE ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_lines_no_truncate BEFORE TRUNCATE ON ledger_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Every entry balances and has at least two lines. Deferred, because an entry
-- is necessarily line-less for the instant between its header and its lines.
CREATE FUNCTION assert_entry_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int; s numeric(14,2);
BEGIN
  SELECT count(*), COALESCE(SUM(amount),0) INTO n, s
    FROM ledger_lines WHERE entry_id = NEW.id;
  IF n < 2 THEN
    RAISE EXCEPTION 'entry % has % line(s); a journal entry needs at least two', NEW.id, n
      USING ERRCODE = 'ERP03';
  END IF;
  IF s <> 0 THEN
    RAISE EXCEPTION 'entry % does not balance: sum=%', NEW.id, s USING ERRCODE = 'ERP03';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entry_complete AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_entry_complete();

-- Manual journals may not touch a control account, and nothing may post into a
-- closed period.
CREATE FUNCTION guard_ledger_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ctl boolean; src text; edate date; pstat text;
BEGIN
  SELECT is_control INTO ctl FROM accounts WHERE code = NEW.account_code;
  SELECT source_doc, entry_date INTO src, edate FROM ledger_entries WHERE id = NEW.entry_id;
  IF ctl AND src = 'manual_journal' THEN
    RAISE EXCEPTION 'account % is a control account; post through its subledger',
      NEW.account_code USING ERRCODE = 'ERP04';
  END IF;
  SELECT status INTO pstat FROM accounting_periods
   WHERE period = date_trunc('month', edate)::date;
  IF pstat = 'CLOSED' THEN
    RAISE EXCEPTION 'accounting period % is closed', date_trunc('month', edate)::date
      USING ERRCODE = 'ERP05';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_line_guard BEFORE INSERT ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION guard_ledger_line();

-- A reversal must be the exact negation of what it reverses.
CREATE FUNCTION assert_reversal_mirrors() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad int;
BEGIN
  IF NEW.reverses_id IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO bad FROM (
    SELECT account_code, product_id, warehouse_id, SUM(amount) AS net
      FROM ledger_lines WHERE entry_id IN (NEW.id, NEW.reverses_id)
     GROUP BY account_code, product_id, warehouse_id
    HAVING SUM(amount) <> 0
  ) q;
  IF bad > 0 THEN
    RAISE EXCEPTION 'entry % does not exactly reverse entry %: % account(s) do not net to zero',
      NEW.id, NEW.reverses_id, bad USING ERRCODE = 'ERP06';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reversal_mirrors_original AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_reversal_mirrors();

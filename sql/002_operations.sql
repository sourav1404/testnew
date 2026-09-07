-- Inventory, procurement and sales.

CREATE TYPE movement_type AS ENUM
  ('GOODS_RECEIPT','SALES_ISSUE','ADJUSTMENT','TRANSFER_IN','TRANSFER_OUT');

-- The append-only source of truth for stock. Nothing here is ever updated.
CREATE TABLE stock_movements (
  id              bigserial PRIMARY KEY,
  product_id      bigint NOT NULL REFERENCES products(id),
  warehouse_id    bigint NOT NULL REFERENCES warehouses(id),
  qty_delta       numeric(14,4) NOT NULL CHECK (qty_delta <> 0),
  unit_cost       numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  movement_type   movement_type NOT NULL,
  source_doc      text NOT NULL,
  source_doc_id   bigint NOT NULL,
  -- NOT NULL: a movement cannot exist without the journal entry that books it.
  ledger_entry_id bigint NOT NULL REFERENCES ledger_entries(id),
  created_by      bigint NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- One rounded figure that both the subledger and the GL share, so the two
  -- cannot drift through different rounding strategies.
  booked_value    numeric(14,2)
    GENERATED ALWAYS AS (round(qty_delta * unit_cost, 2)) STORED,
  CONSTRAINT movement_sign_matches_type CHECK (
    (movement_type IN ('GOODS_RECEIPT','TRANSFER_IN') AND qty_delta > 0) OR
    (movement_type IN ('SALES_ISSUE','TRANSFER_OUT')  AND qty_delta < 0) OR
     movement_type = 'ADJUSTMENT')
);
CREATE INDEX ON stock_movements (product_id, warehouse_id, id);
CREATE INDEX ON stock_movements (ledger_entry_id);
CREATE INDEX ON stock_movements (source_doc, source_doc_id);

CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- The movement must book exactly what its entry posts to Inventory for that
-- product and warehouse. Deferred, so the movement and its lines may be written
-- in either order inside one transaction.
CREATE FUNCTION assert_movement_posted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gl numeric(14,2);
BEGIN
  SELECT COALESCE(SUM(amount),0) INTO gl FROM ledger_lines
   WHERE entry_id = NEW.ledger_entry_id AND account_code = '1300'
     AND product_id = NEW.product_id AND warehouse_id = NEW.warehouse_id;
  IF gl <> NEW.booked_value THEN
    RAISE EXCEPTION 'movement % books % but entry % posts % to Inventory',
      NEW.id, NEW.booked_value, NEW.ledger_entry_id, gl USING ERRCODE = 'ERP07';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER movement_ties_to_ledger AFTER INSERT ON stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_movement_posted();

-- A projection of stock_movements and stock_reservations. It exists so
-- availability is O(1) and so there is a single row to lock per SKU/warehouse.
CREATE TABLE stock_balances (
  product_id    bigint NOT NULL REFERENCES products(id),
  warehouse_id  bigint NOT NULL REFERENCES warehouses(id),
  on_hand_qty   numeric(14,4) NOT NULL DEFAULT 0,
  reserved_qty  numeric(14,4) NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  avg_unit_cost numeric(14,4) NOT NULL DEFAULT 0,
  version       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, warehouse_id),
  -- The backstop: a code path that forgets to lock still cannot oversell.
  CONSTRAINT no_oversell CHECK (on_hand_qty - reserved_qty >= 0)
);

-- CHANGE 1 from Stage 1. The old body was:
--     INSERT INTO stock_balances (..., on_hand_qty, ...)
--     VALUES (..., NEW.qty_delta, ...) ON CONFLICT DO UPDATE SET ...
-- Postgres evaluates CHECK constraints on the proposed tuple before it takes
-- the ON CONFLICT branch, so no_oversell saw on_hand_qty = qty_delta, which is
-- negative on every issue. No SALES_ISSUE could succeed at any stock level.
CREATE FUNCTION apply_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stock_balances (product_id, warehouse_id, on_hand_qty, reserved_qty, avg_unit_cost)
  VALUES (NEW.product_id, NEW.warehouse_id, 0, 0, 0)
  ON CONFLICT (product_id, warehouse_id) DO NOTHING;

  -- Every SET expression reads the pre-update row, so the moving average is
  -- computed against the old on_hand_qty, and no_oversell sees the true
  -- post-state rather than a tuple that is never stored.
  UPDATE stock_balances SET
    avg_unit_cost = CASE
      WHEN NEW.qty_delta > 0 AND (on_hand_qty + NEW.qty_delta) <> 0
      THEN round(((on_hand_qty * avg_unit_cost) + (NEW.qty_delta * NEW.unit_cost))
                 / (on_hand_qty + NEW.qty_delta), 4)
      ELSE avg_unit_cost END,
    on_hand_qty = on_hand_qty + NEW.qty_delta,
    version     = version + 1
  WHERE product_id = NEW.product_id AND warehouse_id = NEW.warehouse_id;
  RETURN NULL;
END $$;
CREATE TRIGGER movement_projects_balance AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_movement();

-- ---------------------------------------------------------------- sales
CREATE TYPE so_status AS ENUM
  ('DRAFT','CONFIRMED','PARTIALLY_FULFILLED','FULFILLED','CANCELLED');
CREATE TYPE reservation_status AS ENUM ('HELD','CONSUMED','RELEASED','EXPIRED');

CREATE TABLE sales_orders (
  id          bigserial PRIMARY KEY,
  so_number   text NOT NULL UNIQUE,
  customer_id bigint NOT NULL REFERENCES customers(id),
  status      so_status NOT NULL DEFAULT 'DRAFT',
  created_by  bigint NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sales_order_lines (
  id            bigserial PRIMARY KEY,
  so_id         bigint NOT NULL REFERENCES sales_orders(id),
  product_id    bigint NOT NULL REFERENCES products(id),
  warehouse_id  bigint NOT NULL REFERENCES warehouses(id),
  qty           numeric(14,4) NOT NULL CHECK (qty > 0),
  unit_price    numeric(14,4) NOT NULL CHECK (unit_price >= 0),
  -- CHANGE 2 from Stage 1: partial fulfilment was unrepresentable without this.
  fulfilled_qty numeric(14,4) NOT NULL DEFAULT 0,
  UNIQUE (so_id, product_id, warehouse_id),
  CONSTRAINT sol_not_over_fulfilled CHECK (fulfilled_qty >= 0 AND fulfilled_qty <= qty),
  CONSTRAINT sol_identity UNIQUE (id, product_id, warehouse_id)
);
-- Backordered quantity is derived, never stored.
CREATE VIEW sales_order_line_status AS
  SELECT l.*, (l.qty - l.fulfilled_qty) AS backordered_qty,
         CASE WHEN l.fulfilled_qty = 0    THEN 'OPEN'
              WHEN l.fulfilled_qty < l.qty THEN 'BACKORDERED'
              ELSE 'FULFILLED' END AS line_status
    FROM sales_order_lines l;

CREATE TABLE stock_reservations (
  id                  bigserial PRIMARY KEY,
  sales_order_line_id bigint NOT NULL,
  product_id          bigint NOT NULL REFERENCES products(id),
  warehouse_id        bigint NOT NULL REFERENCES warehouses(id),
  qty                 numeric(14,4) NOT NULL CHECK (qty > 0),
  status              reservation_status NOT NULL DEFAULT 'HELD',
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT res_expiry_sane CHECK (expires_at > created_at),
  -- A reservation cannot name a different SKU than the line it belongs to.
  CONSTRAINT fk_res_line_sku FOREIGN KEY (sales_order_line_id, product_id, warehouse_id)
    REFERENCES sales_order_lines (id, product_id, warehouse_id)
);
CREATE UNIQUE INDEX one_live_hold_per_line
  ON stock_reservations (sales_order_line_id) WHERE status = 'HELD';
CREATE INDEX res_sweep ON stock_reservations (expires_at) WHERE status = 'HELD';

CREATE FUNCTION reservation_transitions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'HELD' THEN
    RAISE EXCEPTION 'reservation % is %; terminal states cannot be revived',
      OLD.id, OLD.status USING ERRCODE = 'ERP08';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservation_state_machine BEFORE UPDATE ON stock_reservations
  FOR EACH ROW EXECUTE FUNCTION reservation_transitions();

CREATE FUNCTION sync_reserved() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p bigint := COALESCE(NEW.product_id, OLD.product_id);
        w bigint := COALESCE(NEW.warehouse_id, OLD.warehouse_id);
BEGIN
  INSERT INTO stock_balances (product_id, warehouse_id) VALUES (p, w)
  ON CONFLICT (product_id, warehouse_id) DO NOTHING;
  -- Absolute recompute, not a delta: a retried or replayed write lands on the
  -- same value, so the projection cannot drift.
  UPDATE stock_balances SET reserved_qty = (
      SELECT COALESCE(SUM(qty),0) FROM stock_reservations
       WHERE product_id = p AND warehouse_id = w AND status = 'HELD')
   WHERE product_id = p AND warehouse_id = w;
  RETURN NULL;
END $$;
CREATE TRIGGER reservation_projects_balance
  AFTER INSERT OR UPDATE OR DELETE ON stock_reservations
  FOR EACH ROW EXECUTE FUNCTION sync_reserved();

-- stock_balances is writable only by the two projection triggers above.
CREATE FUNCTION balances_are_derived() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'stock_balances is a projection of stock_movements and stock_reservations; write those instead'
      USING ERRCODE = 'ERP09';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_balances_no_direct_write
  BEFORE INSERT OR UPDATE OR DELETE ON stock_balances
  FOR EACH ROW EXECUTE FUNCTION balances_are_derived();

-- ---------------------------------------------------------------- procurement
CREATE TYPE po_status AS ENUM
  ('DRAFT','PENDING_APPROVAL','APPROVED','RECEIVING','CLOSED','CANCELLED');

CREATE TABLE purchase_orders (
  id             bigserial PRIMARY KEY,
  po_number      text NOT NULL UNIQUE,
  supplier_id    bigint NOT NULL REFERENCES suppliers(id),
  status         po_status NOT NULL DEFAULT 'DRAFT',
  total_amount   numeric(14,2) NOT NULL DEFAULT 0,
  created_by     bigint NOT NULL REFERENCES users(id),
  approved_by    bigint REFERENCES users(id),
  approved_at    timestamptz,
  approved_limit numeric(14,2),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Separation of duties in the engine, not in a service method.
  CONSTRAINT po_maker_checker CHECK (approved_by IS NULL OR approved_by <> created_by),
  CONSTRAINT po_approval_complete CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT po_within_limit CHECK (approved_by IS NULL
    OR (approved_limit IS NOT NULL AND total_amount <= approved_limit))
);

CREATE TABLE purchase_order_lines (
  id           bigserial PRIMARY KEY,
  po_id        bigint NOT NULL REFERENCES purchase_orders(id),
  product_id   bigint NOT NULL REFERENCES products(id),
  warehouse_id bigint NOT NULL REFERENCES warehouses(id),
  ordered_qty  numeric(14,4) NOT NULL CHECK (ordered_qty > 0),
  unit_price   numeric(14,4) NOT NULL CHECK (unit_price >= 0),
  UNIQUE (po_id, product_id, warehouse_id)
);

CREATE TABLE goods_receipts (
  id          bigserial PRIMARY KEY,
  po_id       bigint NOT NULL REFERENCES purchase_orders(id),
  received_by bigint NOT NULL REFERENCES users(id),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE goods_receipt_lines (
  id                bigserial PRIMARY KEY,
  goods_receipt_id  bigint NOT NULL REFERENCES goods_receipts(id),
  po_line_id        bigint NOT NULL REFERENCES purchase_order_lines(id),
  received_qty      numeric(14,4) NOT NULL CHECK (received_qty > 0),
  stock_movement_id bigint NOT NULL REFERENCES stock_movements(id),
  -- Over-receipt is accepted only when someone with the permission says so,
  -- and the fact is recorded on the row rather than inferred later.
  over_receipt      boolean NOT NULL DEFAULT false,
  UNIQUE (goods_receipt_id, po_line_id)
);

-- Outstanding quantity is derived from receipts, never stored on the PO line.
CREATE VIEW po_line_status AS
  SELECT l.id AS po_line_id, l.po_id, l.product_id, l.warehouse_id,
         l.ordered_qty, l.unit_price,
         COALESCE(r.received, 0) AS received_qty,
         l.ordered_qty - COALESCE(r.received, 0) AS outstanding_qty,
         COALESCE(r.received, 0) > l.ordered_qty AS is_over_received
    FROM purchase_order_lines l
    LEFT JOIN (SELECT po_line_id, SUM(received_qty) AS received
                 FROM goods_receipt_lines GROUP BY po_line_id) r
      ON r.po_line_id = l.id;

-- CHANGE 3 from Stage 1: the PO line is now locked before its siblings are
-- summed. Without this, two concurrent receipts each see the other as absent
-- and both pass. Stage 1 named this gap in writing and left it open.
CREATE FUNCTION check_over_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ordered numeric(14,4); got numeric(14,4);
BEGIN
  SELECT ordered_qty INTO ordered FROM purchase_order_lines
   WHERE id = NEW.po_line_id FOR UPDATE;
  SELECT COALESCE(SUM(received_qty),0) INTO got FROM goods_receipt_lines
   WHERE po_line_id = NEW.po_line_id;
  IF got + NEW.received_qty > ordered AND NOT NEW.over_receipt THEN
    RAISE EXCEPTION 'over-receipt on PO line %: ordered %, already received %, attempted %',
      NEW.po_line_id, ordered, got, NEW.received_qty USING ERRCODE = 'ERP10';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goods_receipt_no_over_receipt BEFORE INSERT ON goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION check_over_receipt();

-- An approved PO is frozen: neither its value nor its lines may change.
CREATE FUNCTION freeze_approved_po() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_by IS NOT NULL AND OLD.status IN ('APPROVED','RECEIVING','CLOSED')
     AND NEW.total_amount <> OLD.total_amount THEN
    RAISE EXCEPTION 'PO % is approved; its value cannot change (was %, tried %)',
      OLD.po_number, OLD.total_amount, NEW.total_amount USING ERRCODE = 'ERP11';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER po_frozen_after_approval BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION freeze_approved_po();

CREATE FUNCTION no_lines_after_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE appr bigint;
BEGIN
  SELECT approved_by INTO appr FROM purchase_orders
   WHERE id = COALESCE(NEW.po_id, OLD.po_id);
  IF appr IS NOT NULL THEN
    RAISE EXCEPTION 'cannot change lines of an approved purchase order'
      USING ERRCODE = 'ERP11';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER po_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION no_lines_after_approval();

-- CHANGE 4 from Stage 1: keyed on (endpoint, key) with a request hash, so one
-- key reused across two endpoints no longer replays the first one's response.
CREATE TABLE idempotency_keys (
  endpoint      text NOT NULL,
  key           text NOT NULL,
  request_hash  text NOT NULL,
  response_code int NOT NULL,
  response_body jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (endpoint, key)
);

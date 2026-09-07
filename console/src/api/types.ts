/** Shapes as the Stage 2 API actually returns them. Money and quantities stay
 *  strings the whole way: the backend keeps them as `numeric` strings so a
 *  float cannot lose a cent, and parsing them here would throw that away. */

export interface Whoami {
  id: number;
  email: string;
  roles: string[];
  permissions: string[];
}

export interface AvailabilityRow {
  sku: string;
  warehouse: string;
  on_hand_qty: string;
  reserved_qty: string;
  available: string;
  avg_unit_cost: string;
}

export interface MovementRow {
  id: string;
  sku: string;
  warehouse: string;
  qty_delta: string;
  unit_cost: string;
  booked_value: string;
  movement_type: "GOODS_RECEIPT" | "SALES_ISSUE" | "ADJUSTMENT" | "TRANSFER_IN" | "TRANSFER_OUT";
  source_doc: string;
  source_doc_id: string;
  ledger_entry_id: string;
  created_at: string;
}

export interface PoLine {
  po_line_id: string;
  sku: string;
  warehouse: string;
  ordered_qty: string;
  received_qty: string;
  outstanding_qty: string;
  is_over_received: boolean;
  unit_price: string;
}

export interface PurchaseOrder {
  id: string;
  po_number: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "RECEIVING" | "CLOSED" | "CANCELLED";
  total_amount: string;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  lines: PoLine[];
}

export interface SoLine {
  id: string;
  sku: string;
  warehouse: string;
  qty: string;
  fulfilled_qty: string;
  backordered_qty: string;
  line_status: "OPEN" | "BACKORDERED" | "FULFILLED";
  unit_price: string;
  held_qty: string;
}

export interface SalesOrder {
  id: string;
  so_number: string;
  status: "DRAFT" | "CONFIRMED" | "PARTIALLY_FULFILLED" | "FULFILLED" | "CANCELLED";
  created_at: string;
  lines: SoLine[];
}

export interface TrialBalanceRow {
  code: string; name: string; kind: string; balance: string;
}

export interface Reconciliation {
  as_of: string | null;
  subledger_value: string;
  gl_inventory_value: string;
  delta: string;
  unbalanced_entries: number;
  status: "TIES" | "DRIFT";
  by_product: Array<{
    sku: string; warehouse: string; on_hand_qty: string;
    reserved_qty: string; avg_unit_cost: string; value: string;
  }>;
}

export interface ConfirmResult {
  sales_order_id: number;
  status: string;
  confirmed_by: number;
  lines: Array<{ sku: string; reserved: string; backordered: string; note?: string }>;
}

export interface ReceiptResult {
  goods_receipt_id: number;
  ledger_entry_id: number;
  gross_value: string;
  policy: "reject_batch" | "reject_line";
  lines: Array<{
    po_line_id: number; received_qty: string; outstanding_qty: string;
    over_receipt: boolean; stock_movement_id: string;
  }>;
  refused: Array<{
    po_line_id: number; reason: string; ordered: string;
    already_received: string; attempted: string;
  }>;
}

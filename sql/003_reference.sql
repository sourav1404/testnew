-- Reference data: chart of accounts, roles, permissions.

INSERT INTO accounts(code,name,kind,is_control) VALUES
 ('1200','Accounts Receivable','ASSET',   false),
 ('1300','Inventory',          'ASSET',   true),   -- ties to stock_movements
 ('1390','Inventory Rounding', 'ASSET',   false),
 ('2000','Accounts Payable',   'LIABILITY',false),
 ('2100','GR-IR Clearing',     'LIABILITY',false),
 ('4000','Revenue',            'REVENUE', false),
 ('5000','Cost of Goods Sold', 'EXPENSE', false),
 ('5900','Inventory Adjustment','EXPENSE',false);

INSERT INTO permissions(code,description) VALUES
 ('inventory.read',       'Read stock levels and movements'),
 ('inventory.adjust',     'Post stock adjustments'),
 ('po.read',              'Read purchase orders'),
 ('po.create',            'Create and submit purchase orders'),
 ('po.approve',           'Approve purchase orders'),
 ('receipt.create',       'Record goods receipts'),
 ('receipt.over_receive', 'Accept a receipt beyond the ordered quantity'),
 ('so.read',              'Read sales orders'),
 ('so.create',            'Create sales orders'),
 ('so.confirm',           'Confirm a sales order and reserve stock'),
 ('so.fulfil',            'Ship a sales order'),
 ('ledger.read',          'Read journals, trial balance and reconciliation'),
 ('ledger.post_manual',   'Post a manual journal entry'),
 ('ledger.reverse',       'Post a reversing entry'),
 ('period.close',         'Close an accounting period'),
 ('admin.manage_users',   'Create users and grant roles');

INSERT INTO roles(code,description,po_approval_limit) VALUES
 ('purchasing_agent',    'Raises purchase orders',            NULL),
 ('purchasing_manager',  'Approves purchase orders',          50000.00),
 ('warehouse_operator',  'Receives goods, adjusts stock',     NULL),
 ('warehouse_supervisor','Warehouse operator plus over-receipt authority', NULL),
 ('sales_rep',           'Raises and confirms sales orders',  NULL),
 ('fulfilment_operator', 'Ships confirmed sales orders',      NULL),
 ('accountant',          'Journals, reconciliation, period close', NULL),
 ('auditor',             'Reads everything, writes nothing',  NULL),
 ('admin',               'Manages users and roles',           NULL);

INSERT INTO role_permissions(role_code,permission_code) VALUES
 ('purchasing_agent','po.create'),   ('purchasing_agent','po.read'),
 ('purchasing_agent','inventory.read'),
 ('purchasing_manager','po.approve'),('purchasing_manager','po.read'),
 ('purchasing_manager','inventory.read'),
 ('warehouse_operator','receipt.create'), ('warehouse_operator','inventory.adjust'),
 ('warehouse_operator','inventory.read'), ('warehouse_operator','po.read'),
 ('warehouse_supervisor','receipt.create'), ('warehouse_supervisor','receipt.over_receive'),
 ('warehouse_supervisor','inventory.adjust'), ('warehouse_supervisor','inventory.read'),
 ('warehouse_supervisor','po.read'),
 ('sales_rep','so.create'), ('sales_rep','so.confirm'), ('sales_rep','so.read'),
 ('sales_rep','inventory.read'),
 ('fulfilment_operator','so.fulfil'), ('fulfilment_operator','so.read'),
 ('fulfilment_operator','inventory.read'),
 ('accountant','ledger.read'), ('accountant','ledger.post_manual'),
 ('accountant','ledger.reverse'), ('accountant','period.close'),
 ('accountant','inventory.read'),
 ('auditor','ledger.read'), ('auditor','inventory.read'),
 ('auditor','po.read'),     ('auditor','so.read'),
 ('admin','admin.manage_users');

-- Maker and checker cannot be the same human. Note admin is deliberately NOT a
-- superuser: if whoever grants roles can also approve their own PO, every other
-- rule here is decoration.
INSERT INTO incompatible_roles(role_a,role_b,reason) VALUES
 ('purchasing_agent','purchasing_manager',
  'maker-checker: the person who raises a PO cannot approve one'),
 ('sales_rep','fulfilment_operator',
  'the person who confirms an order cannot also ship it');

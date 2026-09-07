import { pool, closePool } from "../src/db.js";

/**
 * Masters and one user per role. The bearer token is the email address -- a
 * deliberate stand-in for a real identity provider, so the tests can assume a
 * role without a login flow. The roles and permissions behind it are real and
 * come from the database on every request.
 */
const USERS: Array<[string, string, string[]]> = [
  ["agent@nw.test",   "Ada Agent",       ["purchasing_agent"]],
  ["manager@nw.test", "Mo Manager",      ["purchasing_manager"]],
  ["wh@nw.test",      "Wes Warehouse",   ["warehouse_operator"]],
  ["whsup@nw.test",   "Sam Supervisor",  ["warehouse_supervisor"]],
  ["sales@nw.test",   "Sal Sales",       ["sales_rep"]],
  ["ship@nw.test",    "Shay Shipper",    ["fulfilment_operator"]],
  ["acct@nw.test",    "Ana Accountant",  ["accountant"]],
  ["audit@nw.test",   "Avi Auditor",     ["auditor"]],
  ["admin@nw.test",   "Al Admin",        ["admin"]],
];

async function main(): Promise<void> {
  for (const [email, name, roles] of USERS) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, full_name) VALUES ($1, $2)
       ON CONFLICT (lower(email)) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id`, [email, name]);
    for (const role of roles) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [rows[0]!.id, role]);
    }
  }

  await pool.query(
    `INSERT INTO warehouses (code, name) VALUES ('WH1','Main'),('WH2','Overflow')
     ON CONFLICT (code) DO NOTHING`);
  await pool.query(
    `INSERT INTO products (sku, name) VALUES
       ('SKU-001','Widget'),('SKU-002','Gadget'),('SKU-003','Gizmo')
     ON CONFLICT (sku) DO NOTHING`);
  await pool.query(
    `INSERT INTO suppliers (code, name) VALUES ('SUP-1','Baltic Supplies')
     ON CONFLICT (code) DO NOTHING`);
  await pool.query(
    `INSERT INTO customers (code, name) VALUES ('CUST-1','Acme Retail')
     ON CONFLICT (code) DO NOTHING`);
  await pool.query(
    `INSERT INTO accounting_periods (period, status)
     VALUES (date_trunc('month', current_date)::date, 'OPEN')
     ON CONFLICT (period) DO NOTHING`);

  const u = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM users`);
  console.log(`seeded ${u.rows[0]!.n} users, 2 warehouses, 3 products`);
}

main().then(closePool).catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});

import { expect, test } from "@playwright/test";
import { api, approvedPo, asPersona, seedStock, uniq } from "./support.js";

/**
 * Requirement 3 and the third pass criterion: loading, empty and error states,
 * and errors surfaced with the server's own reasoning rather than swallowed.
 */
test.describe("loading, empty and error states", () => {
  test("an over-receipt is refused and the arithmetic is shown to the operator", async ({ browser }) => {
    const poId = await approvedPo("E2E-D", "10");
    const ctx = await browser.newContext(asPersona("wh@nw.test"));
    const page = await ctx.newPage();
    await page.goto("/#/procurement");

    await page.getByPlaceholder("PO id").fill(String(poId));
    await expect(page.locator(".pill", { hasText: /APPROVED|PENDING_APPROVAL/ })).toBeVisible();

    // 12 against an order of 10, with no authority to accept it.
    await page.getByPlaceholder("0").first().fill("12");
    await page.getByRole("button", { name: "Record goods receipt" }).click();

    const banner = page.getByTestId("error-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Over receipt");
    // The server's numbers, not a generic message.
    await expect(banner).toContainText("10.0000");
    await expect(banner).toContainText("12");
    console.log(`  [error] ${(await banner.textContent())?.replace(/\s+/g, " ").slice(0, 160)}`);
    await ctx.close();
  });

  test("a supervisor using reject_line books the good line and is told about the bad one",
    async ({ browser }) => {
      const poId = await approvedPo("E2E-E", "10");
      const ctx = await browser.newContext(asPersona("whsup@nw.test"));
      const page = await ctx.newPage();
      await page.goto("/#/procurement");
      await page.getByPlaceholder("PO id").fill(String(poId));
      await expect(page.getByRole("button", { name: "Record goods receipt" })).toBeVisible();

      // The over-receipt checkbox is available to this role, unlike the operator's.
      const check = page.getByLabel(/Accept an over-receipt/);
      await expect(check).toBeEnabled();
      await check.check();
      await page.getByPlaceholder("0").first().fill("12");
      await page.getByRole("button", { name: "Record goods receipt" }).click();

      const info = page.locator(".banner-info");
      await expect(info).toContainText("over-receipt");
      console.log(`  [over-receipt accepted] ${(await info.textContent())?.replace(/\s+/g, " ").slice(0, 140)}`);
      // Outstanding goes negative rather than being clamped, and is labelled.
      await expect(page.getByText("over-received").first()).toBeVisible();
      await ctx.close();
    });

  test("shipping an order with nothing held surfaces the refusal", async ({ browser }) => {
    const sku = "E2E-A";
    await seedStock(sku, "1");
    // The fulfilment operator holds so.fulfil but not so.create or so.confirm,
    // which is the real split of duties -- so the order is raised elsewhere and
    // opened here by id, deliberately without being confirmed.
    const so = await api<{ sales_order_id: number }>("sales@nw.test", "POST", "/sales-orders", {
      so_number: uniq("SO"), customer_code: "CUST-1",
      lines: [{ sku, warehouse: "WH1", qty: "1", unit_price: "20.00" }],
    });

    const ctx = await browser.newContext(asPersona("ship@nw.test"));
    const page = await ctx.newPage();
    await page.goto("/#/sales");
    // The controls this role cannot use are replaced by the missing permission.
    await expect(page.locator(".locked code", { hasText: "so.create" })).toBeVisible();

    await page.getByPlaceholder("SO id").fill(String(so.sales_order_id));
    await page.getByRole("button", { name: "Fulfil" }).click();

    const banner = page.getByTestId("error-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Nothing to ship");
    console.log(`  [409] ${(await banner.textContent())?.replace(/\s+/g, " ").slice(0, 130)}`);
    await ctx.close();
  });

  test("a missing purchase order shows a 404, not a blank panel", async ({ browser }) => {
    const ctx = await browser.newContext(asPersona("agent@nw.test"));
    const page = await ctx.newPage();
    await page.goto("/#/procurement");
    await page.getByPlaceholder("PO id").fill("999999");
    const banner = page.getByTestId("error-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Not found");
    console.log(`  [404] ${(await banner.textContent())?.replace(/\s+/g, " ").slice(0, 110)}`);
    await ctx.close();
  });

  test("the reconciliation badge reports the verdict from the backend", async ({ browser }) => {
    const ctx = await browser.newContext(asPersona("acct@nw.test"));
    const page = await ctx.newPage();
    await page.goto("/#/finance");
    const badge = page.getByTestId("recon-badge");
    await expect(badge).toContainText("ledger matches inventory: yes");
    await expect(page.getByText(/Ledger balance matches inventory movements: YES/)).toBeVisible();
    console.log(`  [reconciliation] ${(await badge.textContent())?.replace(/\s+/g, " ")}`);
    await ctx.close();
  });
});

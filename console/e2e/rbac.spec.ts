import { expect, test } from "@playwright/test";
import { api, asPersona } from "./support.js";

/**
 * Requirement 5. Two roles, and the surface genuinely differs -- then a direct
 * call proving the hiding is cosmetic and the server is the authority.
 */
test.describe("role-based surface", () => {
  test("a sales rep and an accountant see different consoles", async ({ browser }) => {
    const sales = await browser.newContext(asPersona("sales@nw.test"));
    const acct = await browser.newContext(asPersona("acct@nw.test"));
    const s = await sales.newPage();
    const a = await acct.newPage();
    await s.goto("/"); await a.goto("/");

    await expect(s.getByTestId("identity")).toContainText("sales_rep");
    await expect(a.getByTestId("identity")).toContainText("accountant");

    // Sales can reach Sales; Finance is locked for them.
    await expect(s.getByRole("button", { name: /^Sales/ })).toBeEnabled();
    await expect(s.getByRole("button", { name: /^Finance/ })).toBeDisabled();
    // The accountant is the mirror image.
    await expect(a.getByRole("button", { name: /^Finance/ })).toBeEnabled();
    await expect(a.getByRole("button", { name: /^Sales/ })).toBeDisabled();

    const salesTabs = await s.getByTestId("tabs").textContent();
    const acctTabs = await a.getByTestId("tabs").textContent();
    console.log(`  [rbac] sales tabs:      ${salesTabs?.replace(/\s+/g, " ")}`);
    console.log(`  [rbac] accountant tabs: ${acctTabs?.replace(/\s+/g, " ")}`);
    expect(salesTabs).not.toBe(acctTabs);

    // Only the accountant gets the reconciliation badge, because only they can
    // read the ledger it comes from.
    await expect(a.getByTestId("recon-badge")).toBeVisible();
    await expect(s.getByTestId("recon-badge")).toHaveCount(0);
    console.log(`  [rbac] accountant badge: ${await a.getByTestId("recon-badge").textContent()}`);

    await sales.close(); await acct.close();
  });

  test("hiding a control is presentation; the server refuses regardless", async () => {
    // The sales rep has no Finance tab. Call the endpoint behind it anyway.
    await expect(api("sales@nw.test", "GET", "/ledger/trial-balance"))
      .rejects.toThrow(/403/);
    // And a warehouse operator cannot approve a purchase order.
    await expect(api("wh@nw.test", "POST", "/purchase-orders/1/approve"))
      .rejects.toThrow(/403/);
    console.log("  [rbac] both hidden actions return 403 when called directly");
  });

  test("a role with a partial view is told which permission is missing", async ({ browser }) => {
    // The purchasing agent can raise a PO but not approve one.
    const ctx = await browser.newContext(asPersona("agent@nw.test"));
    const page = await ctx.newPage();
    await page.goto("/#/procurement");
    await expect(page.getByRole("button", { name: "Create order" })).toBeVisible();
    await page.getByLabel("SKU").first().fill("E2E-D");
    await page.getByRole("button", { name: "Create order" }).click();
    // The approve control is replaced by an explanation naming the permission.
    await expect(page.getByText("po.approve")).toBeVisible();
    console.log("  [rbac] agent sees the approve control replaced by the missing permission");
    await ctx.close();
  });
});

import { expect, test } from "@playwright/test";
import { asPersona, availability, reserveElsewhere, seedStock } from "./support.js";

/**
 * Requirement 2 and the second pass criterion. The console must show live
 * availability, and a reservation taken by another session must be visible
 * here without the operator doing anything.
 */
test.describe("live availability under concurrent reservation", () => {
  test("a reservation from another session reduces availability on screen", async ({ browser }) => {
    const sku = "E2E-A";
    await seedStock(sku, "3");
    expect(await availability(sku)).toBe("3.0000");

    const ctx = await browser.newContext(asPersona("sales@nw.test"));
    const page = await ctx.newPage();
    await page.goto("/#/sales");

    const cell = page.getByTestId(`avail-${sku}`).getByTestId("available");
    await expect(cell).toHaveText("3.0000");
    console.log(`  [live] on screen before: ${await cell.textContent()}`);

    // A second session takes two units. No interaction with this page at all.
    await reserveElsewhere(sku, "2");

    // No reload, no click: the resource polls and revalidates.
    await expect(cell).toHaveText("1.0000");
    console.log(`  [live] on screen after another session reserved 2: ${await cell.textContent()}`);

    // First pass criterion: a fresh load agrees, so what we saw was not a
    // local patch that happens to look right.
    await page.reload();
    await expect(page.getByTestId(`avail-${sku}`).getByTestId("available")).toHaveText("1.0000");
    console.log("  [live] after a full page reload: still 1.0000");
    await ctx.close();
  });

  test("two browser sessions, one reserves, the other sees it fall", async ({ browser }) => {
    const sku = "E2E-B";
    await seedStock(sku, "2");

    const watcher = await browser.newContext(asPersona("wh@nw.test"));
    const buyer = await browser.newContext(asPersona("sales@nw.test"));
    const watching = await watcher.newPage();
    const buying = await buyer.newPage();

    await watching.goto("/#/warehouse");
    const row = watching.locator("tr", { has: watching.locator(`code:text-is("${sku}")`) });
    await expect(row).toContainText("2.0000");
    console.log("  [two sessions] watcher sees 2.0000 available");

    // The buyer drives the real UI: create, then confirm.
    await buying.goto("/#/sales");
    await buying.getByLabel("SKU").first().fill(sku);
    await buying.getByLabel("Qty").first().fill("2");
    await buying.getByRole("button", { name: "Create order" }).click();
    await buying.getByRole("button", { name: "Confirm and reserve" }).click();
    await expect(buying.getByText("Reservation result")).toBeVisible();
    console.log("  [two sessions] buyer confirmed 2 through the UI");

    // The watcher's warehouse view polls; reserved rises and available falls.
    await expect(row).toContainText("0.0000");
    console.log("  [two sessions] watcher now sees 0.0000 available, without touching anything");
    expect(await availability(sku)).toBe("0.0000");

    await watcher.close(); await buyer.close();
  });

  test("an order larger than stock reserves what exists and backorders the rest", async ({ browser }) => {
    const sku = "E2E-C";
    await seedStock(sku, "5");
    const ctx = await browser.newContext(asPersona("sales@nw.test"));
    const page = await ctx.newPage();
    await page.goto("/#/sales");

    await page.getByLabel("SKU").first().fill(sku);
    await page.getByLabel("Qty").first().fill("8");
    // The live figure sits beside the input and warns before submission.
    await expect(page.getByText("will partly backorder")).toBeVisible();

    await page.getByRole("button", { name: "Create order" }).click();
    await page.getByRole("button", { name: "Confirm and reserve" }).click();

    const result = page.locator(".banner-info", { hasText: "Reservation result" });
    await expect(result).toContainText("reserved");
    await expect(result).toContainText("backordered");
    console.log(`  [partial] ${(await result.textContent())?.replace(/\s+/g, " ").slice(0, 120)}`);

    // The order's own line: 5 held, nothing shipped, 3 with no stock behind it.
    // The API's line_status is OPEN here, because it keys off fulfilled_qty and
    // ignores holds -- so the console shows its own Uncovered figure alongside.
    const row = page.locator("tbody tr", { has: page.locator(`code:text-is("${sku}")`) }).last();
    await expect(row.getByTestId("uncovered")).toHaveText("3.0000");
    await expect(row).toContainText("OPEN");
    console.log(`  [partial] line: ${(await row.textContent())?.replace(/\s+/g, " ")}`);
    await ctx.close();
  });
});

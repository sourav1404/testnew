import { expect, test } from "@playwright/test";
import { asPersona } from "./support.js";

/**
 * Named to sort first, because these assertions only mean something against
 * the freshly reset backend that global setup leaves behind. A test that
 * asserts "empty" after other specs have created stock is asserting nothing.
 */
test.describe("first load against a freshly reset backend", () => {
  test("an empty warehouse says so, rather than rendering an empty table", async ({ browser }) => {
    const ctx = await browser.newContext(asPersona("audit@nw.test"));
    const page = await ctx.newPage();
    await page.goto("/#/warehouse");

    const empty = page.locator(".empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("Receive against a purchase order first");
    // And no table at all, so nobody mistakes a header row for data.
    await expect(page.locator("table")).toHaveCount(0);
    console.log(`  [empty] ${await empty.textContent()}`);
    await ctx.close();
  });

  test("the ledger already ties before any stock exists", async ({ browser }) => {
    const ctx = await browser.newContext(asPersona("acct@nw.test"));
    const page = await ctx.newPage();
    await page.goto("/#/finance");
    await expect(page.getByTestId("recon-badge")).toContainText("ledger matches inventory: yes");
    // Zero against zero still ties, and the trial balance is already balanced.
    await expect(page.getByText(/Ledger balance matches inventory movements: YES/)).toBeVisible();
    const badge = await page.getByTestId("recon-badge").textContent();
    console.log(`  [fresh ledger] ${badge?.replace(/\s+/g, " ")}`);
    await ctx.close();
  });

  test("a fresh load shows the loading state before data arrives", async ({ browser }) => {
    const ctx = await browser.newContext(asPersona("wh@nw.test"));
    const page = await ctx.newPage();
    // Hold the response so the loading state is observable rather than a flash.
    await page.route("**/inventory/availability*", async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    await page.goto("/#/warehouse");
    await expect(page.locator(".skeleton")).toBeVisible();
    console.log("  [loading] skeleton visible while the request is in flight");
    await page.unroute("**/inventory/availability*");
    await ctx.close();
  });

  test("an unreachable API is reported as such, not as an empty screen", async ({ browser }) => {
    const ctx = await browser.newContext(asPersona("wh@nw.test"));
    const page = await ctx.newPage();
    // Simulate the backend being down for every call this page makes.
    await page.route("http://localhost:3000/**", (route) => route.abort("connectionrefused"));
    await page.goto("/#/warehouse");
    const banner = page.getByTestId("error-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Is the Stage 2 backend running?");
    console.log(`  [offline] ${(await banner.textContent())?.replace(/\s+/g, " ").slice(0, 120)}`);
    await ctx.close();
  });
});

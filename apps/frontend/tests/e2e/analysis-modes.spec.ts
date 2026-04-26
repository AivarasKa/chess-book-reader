import { expect, test } from "@playwright/test";

test.describe("analysis modes", () => {
  test("local history board is visible when switching modes", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-local").click();
    await expect(page.locator(".local-board-wrap")).toBeVisible();
  });

  test("can add and remove local history item", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-local").click();

    await page.getByTestId("history-name-input").fill("Test puzzle");
    await page.getByTestId("history-add").click();

    const select = page.getByTestId("history-select");
    await expect(select).toBeVisible();
    await expect(select.locator("option")).toHaveCount(2);
    await expect(select.locator("option").nth(1)).toHaveText("Test puzzle");

    await page.getByTestId("history-remove").click();
    await expect(page.getByTestId("history-select")).toHaveCount(0);
  });

  test("mode switch preserves local history session state", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-local").click();
    await page.getByTestId("history-name-input").fill("Keep me");
    await page.getByTestId("history-add").click();

    await page.getByTestId("mode-lichess").click();
    await page.getByTestId("mode-local").click();

    const select = page.getByTestId("history-select");
    await expect(select).toBeVisible();
    await expect(select.locator("option").nth(1)).toHaveText("Keep me");
  });
});

/** §51：感知層與派工紀錄都在 wire 上——Local Demo（fixture 回放）也看得到：
 *  選取 AMR → 卡片有 perception 列；Audit 分頁有 Dispatch Decisions 列。 */
import { expect, test } from "@playwright/test";

test("selected AMR card shows perception; audit tab lists dispatch decisions (demo)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".live")).toContainText("LOCAL DEMO", { timeout: 15_000 });
  await page.waitForFunction(() => (window as any).__selectAmr !== undefined
    && (window as any).__twin.getState().amrLive["AMR-01"]?.perception);
  await page.evaluate(() => (window as any).__selectAmr("AMR-01"));
  const card = page.locator(".amrcard");
  await expect(card).toBeVisible();
  await expect(card).toContainText(/perception\s*(CLEAR|CAUTION|STOPPED)/);
  await expect(card).toContainText("safe/clear/stop 2/2.6/1.2 m");
  await page.locator("button", { hasText: "Audit" }).first().click();
  const rows = page.locator(".drow");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(1);
  await rows.first().click();
  await expect(page.locator(".dcands .dc").first()).toContainText(/AMR-0[12]/);
  // 規則句與理由句一起顯示（因果可見）
  await expect(rows.first()).toContainText(/chosen|deferred/);
});

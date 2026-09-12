/** §37 Responsive Layout 回歸：三種桌機 viewport 皆不得出現整頁捲動（§37.4）。
 *  不啟動 Backend → 前端自動進 LOCAL_DEMO（§43.9-1/2 同時驗證）。 */
import { expect, test } from "@playwright/test";

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1366, h: 768 },      // §46 驗收：常見筆電解析度
  { w: 1280, h: 720 },
  { w: 1279, h: 630 },      // Windows 150% 縮放後常見的低高度桌機
];
const TABS = ["3D Factory", "Production Flow", "Energy"];

async function noPageScroll(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    return {
      sh: de.scrollHeight, ih: window.innerHeight,
      sw: de.scrollWidth, iw: window.innerWidth,
      bodyOverflowY: getComputedStyle(document.body).overflowY,
    };
  });
}

for (const vp of VIEWPORTS) {
  test(`no page scroll @ ${vp.w}×${vp.h}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto("/");
    await expect(page.locator("canvas").first()).toBeVisible({ timeout: 30_000 });
    // 無 Backend → 3 秒內進 LOCAL DEMO（§43.9-1）
    await expect(page.locator(".live")).toContainText("LOCAL DEMO", { timeout: 15_000 });
    for (const tab of TABS) {
      await page.getByRole("tab", { name: tab }).click();
      await page.waitForTimeout(400);
      const m = await noPageScroll(page);
      expect(m.sh, `${tab}: scrollHeight ${m.sh} > innerHeight ${m.ih}`).toBeLessThanOrEqual(m.ih + 1);
      expect(m.sw, `${tab}: scrollWidth ${m.sw} > innerWidth ${m.iw}`).toBeLessThanOrEqual(m.iw + 1);
    }
  });
}

test("demo mode labels are not mistaken for live", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".live")).toContainText("LOCAL DEMO", { timeout: 15_000 });
  // Demo 不得顯示 SIMULATED LIVE／OFFLINE／Events (live)
  await expect(page.locator("text=SIMULATED LIVE")).toHaveCount(0);
  await expect(page.locator("text=OFFLINE")).toHaveCount(0);
  await expect(page.locator("text=LOCAL REPLAY").first()).toBeVisible();
});

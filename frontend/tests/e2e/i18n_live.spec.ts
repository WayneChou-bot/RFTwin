/** §56 介面語言（Live 部分）：注入回饋訊息同樣是暫態——需要 Live backend（Local Demo 鎖住 Inject）。
 *  獨立成檔：CI 的 Live 階段只跑本檔＋reset_live＋sync（i18n.spec 需 Local Demo，兩者不能同時成立）。 */
import { expect, test } from "@playwright/test";

test("injection feedback re-renders in the newly selected language", async ({ page }) => {
  test.skip(!process.env.E2E_LIVE, "needs live backend (E2E_LIVE=1 TWIN_PORT=<port>)");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".live")).toContainText("LIVE", { timeout: 60_000 });
  await page.locator("[data-testid=langsw] button", { hasText: "EN" }).click();
  await page.locator(".rtabs button", { hasText: "Inject" }).click();
  await page.locator(".injgrid button", { hasText: "W-01 Minor Stop" }).click();
  // 重跑時 W-01 可能仍在停機（引擎回 422）：接受／拒絕兩條路徑都要隨語言切換，引擎原因句維持英文
  await expect(page.locator(".injmsg")).toContainText(/W-01 Minor Stop (injected \(recorded in Audit\)|rejected: )/);
  await page.locator("[data-testid=langsw] button", { hasText: "中" }).click();
  // Review：中文回饋內的操作名稱也要是中文（不再是 "W-01 Minor Stop 已注入"）
  await expect(page.locator(".injmsg")).toContainText(/W-01 短暫停機 (已注入（Audit 已記錄）|被拒絕：)/);
  await expect(page.locator(".injmsg")).not.toContainText("Minor Stop");
  await expect(page.getByRole("textbox", { name: "障礙物半徑（m）" })).toBeVisible();   // P3：aria-label 也切換
  await page.locator("[data-testid=langsw] button", { hasText: "EN" }).click();
  await expect(page.locator(".injmsg")).toContainText(/(injected \(recorded in Audit\)|rejected: )/);
});

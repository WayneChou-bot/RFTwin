/** §56 介面語言：預設依瀏覽器語言（Playwright 預設 en-US → 英文）；點「中」→ 全介面切繁中、
 *  <html lang> 更新、重新整理後仍記住；引擎產生的內容（事件、派工理由）維持英文。 */
import { expect, test } from "@playwright/test";

test("language switch is complete, persisted and leaves engine text untouched", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".live")).toContainText("LOCAL DEMO", { timeout: 15_000 });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("tab", { name: "Production Flow" })).toBeVisible();
  await expect(page.locator(".panel h2").first()).toHaveText("Process Cells");
  await expect(page.locator("[data-testid=langsw] button", { hasText: "EN" })).toHaveAttribute("aria-pressed", "true");
  await page.locator("[data-testid=langsw] button", { hasText: "中" }).click();
  await expect(page.locator("[data-testid=langsw] button", { hasText: "中" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-testid=langsw] button", { hasText: "EN" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await expect(page.getByRole("tab", { name: "生產流程" })).toBeVisible();
  await expect(page.locator(".panel h2").first()).toHaveText("製程 Cell");
  await expect(page.locator(".rtabs button").nth(1)).toHaveText("注入");
  await expect(page.locator(".bottom .tile h3").first()).toContainText("本班累計");
  // 每個視圖都切到中文（標題＋內容），且沒有殘留英文 UI 標籤
  for (const [tab, h2, probe] of [["生產流程", "生產流程", "節拍"], ["手臂健康", "機械手臂健康", "完成數"],
      ["品質", "品質 — 視覺檢測", "模型一致率"], ["能源", "能源", "閒置浪費"], ["模擬", "模擬紀錄", "Scenario"]] as const) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.locator(".panel.center h2")).toHaveText(h2);
    await expect(page.locator(".viewhost")).toContainText(probe, { timeout: 10_000 });
  }
  await page.getByRole("tab", { name: "3D 工廠" }).click();
  // Inject 分頁（Local Demo 鎖住）：停用說明也是中文
  await page.locator(".rtabs button", { hasText: "注入" }).click();
  await expect(page.locator(".det .placeholder b")).toHaveText("需要 Live 後端");
  // Audit 分頁：UI 中文，但引擎產生的派工理由句維持英文（設計決定）
  await page.locator(".rtabs button", { hasText: "稽核" }).click();
  await expect(page.locator(".det .sect").first()).toContainText("派工決策");
  const reason = page.locator(".drow .dreason").first();
  await expect(reason).toBeVisible();
  expect(await reason.textContent()).toMatch(/^[\x20-\x7e…→·]+$/);   // 純 ASCII（含箭頭／間隔號）
  // §56 Review P2：Analyze 結果是「存起來的暫態」，切換語言後也要跟著換（同一份 snapshot 重算）
  await page.locator(".rtabs button").first().click();                      // 詳情
  await page.locator(".camctl button", { hasText: "分析" }).click();
  await expect(page.locator(".camana")).toContainText("工位運作中");
  await page.locator("[data-testid=langsw] button", { hasText: "EN" }).click();
  await expect(page.locator(".camana")).toContainText("stations active");
  await expect(page.locator(".camana")).not.toContainText("工位");
  await page.locator("[data-testid=langsw] button", { hasText: "中" }).click();
  await expect(page.locator(".camana")).toContainText("工位運作中");
  // 無障礙名稱也國際化（P3）
  await expect(page.getByRole("tablist", { name: "儀表板視圖" })).toBeVisible();
  // 記住選擇
  await page.reload();
  await expect(page.locator(".live")).toContainText("LOCAL DEMO", { timeout: 15_000 });
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await expect(page.locator(".panel h2").first()).toHaveText("製程 Cell");
  // 切回英文
  await page.locator("[data-testid=langsw] button", { hasText: "EN" }).click();
  await expect(page.locator(".panel h2").first()).toHaveText("Process Cells");
});

/** 注入回饋訊息同樣是暫態：需要 Live backend（Local Demo 鎖住 Inject）。 */
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

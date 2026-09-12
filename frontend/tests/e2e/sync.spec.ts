/** §51 穩健性（需要 Live backend；`E2E_LIVE=1 TWIN_PORT=<port>` 執行，否則跳過）：
 *  1) 另一分頁按暫停／倍速／播放 → 切回本分頁時狀態一致（背景分頁的 WebSocket 可能被瀏覽器節流；
 *     回前景時 control 廣播或 visibilitychange 重抓二者之一保證同步——這正是 §51 設計的情境）；
 *  2) visibilitychange → resyncs +1、lastResync="visibility"（headless 無真實事件，以合成事件觸發同一路徑）。
 *  注意：背景分頁不跑 requestAnimationFrame，waitForFunction 一律用固定間隔 polling。 */
import { expect, test } from "@playwright/test";

test.skip(!process.env.E2E_LIVE, "needs live backend (E2E_LIVE=1 TWIN_PORT=<port>)");

const state = (p: import("@playwright/test").Page) =>
  p.evaluate(() => { const s = (window as any).__twin.getState(); return { paused: s.paused, speed: s.speed, resyncs: s.resyncs, last: s.lastResync }; });

test("controls sync across tabs; returning to a tab resyncs the authoritative snapshot", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  for (const p of [a, b]) {
    await p.goto("/");
    await expect(p.locator(".live")).toContainText("LIVE", { timeout: 60_000 });
  }
  const step = async (act: () => Promise<void>, expectFn: (s: { paused: boolean; speed: number }) => boolean) => {
    await b.bringToFront();
    await act();
    await b.waitForTimeout(300);
    await a.bringToFront();                       // 回前景：control 廣播或 visibilitychange 重抓
    await a.waitForFunction((fnSrc) => (new Function("s", "return (" + fnSrc + ")(s)"))((window as any).__twin.getState()), expectFn.toString(), { timeout: 20_000, polling: 250 });
  };
  await step(() => b.locator(".simctl button[title='Pause']").click(), (s) => s.paused === true);
  await step(() => b.locator(".simctl button", { hasText: "5×" }).first().click(), (s) => s.speed === 5);
  await step(() => b.locator(".simctl button[title='Run']").click(), (s) => s.paused === false);
  await step(() => b.locator(".simctl button", { hasText: "1×" }).first().click(), (s) => s.speed === 1);
  // visibilitychange → 重抓：headless Chromium 的 bringToFront 不改變 document.visibilityState
  // （所有分頁皆 visible），故以合成事件觸發同一條程式路徑；真機上由瀏覽器自然觸發。
  const before = (await state(a)).resyncs;
  await a.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await a.waitForFunction((n) => (window as any).__twin.getState().resyncs > n, before, { timeout: 20_000, polling: 250 });
  expect((await state(a)).last).toBe("visibility");
  await ctx.close();
});

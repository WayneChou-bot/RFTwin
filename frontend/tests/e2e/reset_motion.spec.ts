/** §48 Reset 後 AMR 畫面位置必須立即等於新 run 的權威位置
 *  （不得從舊位置倒車穿越工廠）。Demo 循環回捲同語意。 */
import { expect, test } from "@playwright/test";

test("after reset the rendered AMR position snaps to the authoritative one", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".live")).toContainText("LOCAL DEMO", { timeout: 15_000 });
  await page.waitForFunction(() => (window as any).__amrRender?.["AMR-01"] !== undefined);
  await page.locator(".simctl button", { hasText: "10×" }).click();
  // 讓 AMR 離開起始位置一段距離
  await page.waitForFunction(() => {
    const s = (window as any).__twin.getState().snap; return s && s.sim_tick > 144000 + 600;
  }, null, { timeout: 30_000 });
  // 回到 1×：外插領先量 ≤ 車速 × 1 s，量測才有意義（10× 時領先可達 12 m）
  await page.locator(".simctl button", { hasText: "1×" }).click();
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => (window as any).__twin.getState().snap.sim_tick);
  await page.locator(".simctl button[data-action='reset']").click();
  await page.waitForFunction((t) => (window as any).__twin.getState().snap.sim_tick < t, before);
  const t0 = Date.now();
  // 3 秒內畫面位置必須貼近新 run 的權威位置（倒車 ~80 m 以 3 m/s 需 ~27 s → 必失敗）
  await page.waitForFunction(() => {
    const s = (window as any).__twin.getState().snap;
    const r = (window as any).__amrRender as Record<string, [number, number]>;
    return s.state.amrs.every((a: any) =>
      Math.hypot(r[a.amr_id][0] - a.position[0], r[a.amr_id][1] - a.position[1]) < 2.5);
  }, null, { timeout: 3000 });
  expect(Date.now() - t0).toBeLessThan(3000);
});

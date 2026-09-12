/** §48 e2e：Reset 回到起點且不倒車、空間障礙物出現且 AMR 改道。
 *  無 Backend → LOCAL_DEMO（fixture 內建 t=45s zone_obstacle 劇本，決定性）。
 *  透過 window.__twin（唯讀 store 掛勾）讀取權威 snapshot——不解析 canvas。 */
import { expect, test } from "@playwright/test";

type State = {
  snap: { sim_tick: number; run_id: string; state: {
    obstacles?: { obstacle_id: string }[];
    amrs: { amr_id: string; traffic_state?: string; position: [number, number] }[] } } | null;
  eventFeed: { event_type: string }[];
};
const read = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const s = (window as any).__twin.getState();
    return { snap: s.snap, eventFeed: s.eventFeed } as State;
  });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".live")).toContainText("LOCAL DEMO", { timeout: 15_000 });
  await page.waitForFunction(() => (window as any).__twin?.getState().snap?.sim_tick > 0);
});

test("reset returns to the deterministic start and keeps playing", async ({ page }) => {
  const simTime = () => page.locator("header .hmeta b").first().textContent();
  await page.locator(".simctl button", { hasText: "10×" }).click();
  await page.waitForFunction(() => {
    const s = (window as any).__twin.getState().snap; return s && s.sim_tick > 144000 + 300;
  }, null, { timeout: 30_000 });
  const before = await read(page);
  const t0 = await simTime();
  await page.locator(".simctl button[data-action='reset']").click();
  await page.waitForFunction((tick) => {
    const s = (window as any).__twin.getState().snap; return s && s.sim_tick < tick;
  }, before.snap!.sim_tick, { timeout: 5_000 });
  const after = await read(page);
  expect(after.snap!.sim_tick).toBeLessThan(before.snap!.sim_tick);
  expect(after.eventFeed.length).toBeLessThanOrEqual(before.eventFeed.length);
  expect(await simTime()).not.toBe(t0);
  // 仍在播放：時間繼續前進
  const t1 = after.snap!.sim_tick;
  await page.waitForFunction((tick) => (window as any).__twin.getState().snap.sim_tick > tick,
    t1, { timeout: 10_000 });
});

test("zone obstacle appears and an AMR detours around it", async ({ page }) => {
  await page.locator(".simctl button", { hasText: "10×" }).click();
  // fixture t=45s → 障礙出現（10× 約 5 s 牆鐘）
  await page.waitForFunction(() => {
    const s = (window as any).__twin.getState().snap; return (s?.state.obstacles ?? []).length > 0;
  }, null, { timeout: 30_000 });
  const st = await read(page);
  expect(st.snap!.state.obstacles![0].obstacle_id).toMatch(/^OBS-/);
  // 期間內事件流出現 OBSTACLE_PLACED 與 AMR_DETOUR／AMR_REROUTED（因果：規劃繞開）
  await page.waitForFunction(() => {
    const f = (window as any).__twin.getState().eventFeed as { event_type: string }[];
    return f.some((e) => e.event_type === "OBSTACLE_PLACED")
      && f.some((e) => e.event_type === "AMR_DETOUR" || e.event_type === "AMR_REROUTED");
  }, null, { timeout: 40_000 });
  // 障礙存在期間，任何 AMR 都不進入障礙圈（半徑 1.5 + 0.5）
  const probe = await page.evaluate(() => {
    const s = (window as any).__twin.getState().snap;
    const ob = s.state.obstacles[0];
    return s.state.amrs.map((a: any) =>
      Math.hypot(a.position[0] - ob.position[0], a.position[1] - ob.position[1]));
  });
  for (const d of probe) expect(d).toBeGreaterThanOrEqual(2.0 - 1e-6);
});

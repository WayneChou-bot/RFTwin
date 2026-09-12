/** 視圖互動回歸（Local Demo 即可重現）：
 *  1. Energy 時間圖切換範圍不得崩潰——hover 索引是上一個範圍的，60→15、Shift→60 後超出資料長度
 *     曾讓 H[hover] undefined 把整頁炸掉（React 卸載整棵樹 → 白畫面）。
 *  2. Robot Health 點一列 → 切回 3D 且鏡頭飛到該機器人。FactoryScene 是重新掛載的，舊寫法把這次
 *     flyRequest 當初始載入吞掉；dev 的 StrictMode 會重跑 effect 所以本機看不出來，production build 才會。
 *  3. 視圖層級 Error Boundary：單一視圖 render 崩潰只換成錯誤卡，Header／KPI 列照常。 */
import { expect, test } from "@playwright/test";

async function openDemo(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".live")).toContainText("LOCAL DEMO", { timeout: 15_000 });
}

test("energy chart range switch survives a stale hover index (60→15, shift→60)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await openDemo(page);
  await page.getByRole("tab", { name: "Energy" }).click();
  const chart = page.locator(".echart");
  await expect(chart).toBeVisible({ timeout: 20_000 });
  // 滑到圖的右緣 → hover = 最後一個索引（59）；再點 15 min
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await chart.locator("button", { hasText: "15 min" }).click();
  await expect(chart.locator("svg polyline")).toBeVisible();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await chart.locator("button", { hasText: "Shift" }).click();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);   // hover 可能到 239
  await chart.locator("button", { hasText: "1 hour" }).click();
  await expect(chart.locator("svg polyline")).toBeVisible();
  await expect(page.locator(".viewerr")).toHaveCount(0);
  await expect(page.locator("header .title")).toContainText("RFTwin");
  expect(errors).toEqual([]);
});

test("clicking a Robot Health row returns to 3D and flies the camera to that robot", async ({ page }) => {
  await openDemo(page);
  await page.waitForFunction(() => (window as any).__camera !== undefined);
  await page.waitForTimeout(1500);                                           // Overview 就位
  const before = await page.evaluate(() => (window as any).__camera as number[]);
  await page.getByRole("tab", { name: "Robot Health" }).click();
  // Local Demo 進場時 panels.json 可能還在背景載入（CI 慢）：getJson 會等 fixture 到齊，這裡給足時間
  await expect(page.locator("table.vtable tbody tr").first()).toBeVisible({ timeout: 20_000 });
  await page.locator("table.vtable tbody tr", { hasText: "R-01" }).first().click();
  await expect(page.getByRole("tab", { name: "3D Factory" })).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => (window as any).__twin.getState().selectedRobot)).toBe("R-01");
  // FlyTo 目標高度 6.5（Overview 33）：2.5 s 內相機應明顯下降並離開 Overview 位置
  await page.waitForFunction((b) => {
    const c = (window as any).__camera as number[] | undefined;
    return !!c && c[1] < 12 && Math.hypot(c[0] - b[0], c[2] - b[2]) > 5;
  }, before, { timeout: 4000 });
});

test("a crashing view is contained by the view-level error boundary", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("tab", { name: "Energy" }).click();
  await expect(page.locator(".echart")).toBeVisible({ timeout: 20_000 });
  // 讓「只有 Energy 視圖」的下一次 render 炸掉：x 軸刻度把 sim_minute 當文字渲染，換成物件 → React 丟
  // "Objects are not valid as a React child"（底部 KPI 列的 sparkline 只讀 good_units／defect_rate／energy_kw，不受影響）
  await page.evaluate(() => {
    const s = (window as any).__twin.getState();
    const snap = JSON.parse(JSON.stringify(s.snap));
    snap.state.history_minutes = snap.state.history_minutes.map((h: any) => ({ ...h, sim_minute: {} }));
    (window as any).__twin.setState({ snap });
  });
  await expect(page.locator(".viewerr")).toBeVisible();
  await expect(page.locator("header .title")).toContainText("RFTwin");   // Header 還在
  await expect(page.locator(".live")).toContainText("LOCAL DEMO");
  await expect(page.locator(".kpi, .kpibar, .bottom").first()).toBeVisible();   // 底部 KPI 列還在
  await page.getByRole("tab", { name: "Production Flow" }).click();            // 切視圖 → 邊界重置
  await expect(page.locator(".viewerr")).toHaveCount(0);
});

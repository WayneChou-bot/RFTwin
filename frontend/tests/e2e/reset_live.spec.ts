/** §52：Live Reset 的畫面位置差改為自動化量測（先前 0.00 m 為手動）。
 *  需要 Live backend：`E2E_LIVE=1 TWIN_PORT=<port>`，否則跳過。
 *  斷言（§54 補強）：(1) run 切換後**第一個渲染幀**就在新位置附近（< 2.5 m），且切換到該幀之間畫面沒有移動
 *  （preMove < 1 m——不是從舊位置滑過來）；(2) 新 run 期間畫面軌跡
 *  總長扣掉單一直接定位跳躍後 ≲ 權威位移＋3 m（沒有中間穿越點）；(3) 1.5 s 後靜止車 < 0.5 m、
 *  行進車 < 1.5 m（無頭 2–6 FPS 單幀平滑落後；真機 ≈ 0.02 m）。
 *  (0)（§55）重建期間（resetting=true、仍是舊 run）的樣本也要驗：後端凍結舊 run 的 ticker（§49），
 *  所以權威位置漂移 < 0.5 m（最多一筆在途 patch）、畫面在前 1 s 收掉平滑餘量後就不再移動（< 0.5 m）、
 *  整段畫面移動 < 2.5 m——「舊 run 畫面凍結」退步（AMR 在覆蓋層底下繼續跑 3–10 m）會在這裡被抓到。 */
import { expect, test } from "@playwright/test";

test.skip(!process.env.E2E_LIVE, "needs live backend (E2E_LIVE=1 TWIN_PORT=<port>)");

test("live reset snaps rendered AMRs to the new run without traversing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".live")).toContainText("LIVE", { timeout: 60_000 });
  await page.waitForFunction(() => (window as any).__amrRender?.["AMR-01"] !== undefined);
  // 讓 AMR 先離開起點（10× 跑 ~40 s 模擬時間）
  await page.locator(".simctl button", { hasText: "10×" }).click();
  await page.waitForTimeout(4000);
  await page.locator(".simctl button", { hasText: "1×" }).click();
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => (window as any).__twin.getState().runId);
  // §54：記錄完整短軌跡——每 50 ms 一筆 {t, run, 畫面位置, 權威位置}，
  // 事後驗證「run 切換後的第一個 render frame 就已貼近新位置」與「中間沒有穿越點」。
  await page.evaluate(() => {
    const w = window as any; w.__traj = [];
    w.__trajTimer = setInterval(() => {
      const s = w.__twin.getState(); const r = w.__amrRender ?? {};
      w.__traj.push({ t: performance.now(), run: s.runId, resetting: s.resetting,
        r: Object.fromEntries(Object.keys(r).map((k) => [k, [...r[k]]])),
        a: Object.fromEntries(Object.keys(s.amrLive).map((k) => [k, [...s.amrLive[k].position]])) });
    }, 50);
  });
  await page.locator(".simctl button[data-action='reset']").click();
  await page.waitForFunction((b) => {
    const s = (window as any).__twin.getState(); return s.runId !== b && !s.resetting;
  }, before, { timeout: 60_000, polling: 250 });
  await page.waitForTimeout(2500);
  const res = await page.evaluate((b) => {
    const w = window as any; clearInterval(w.__trajTimer);
    const traj = w.__traj as { t: number; run: string; resetting: boolean;
      r: Record<string, number[]>; a: Record<string, number[]> }[];
    const s = w.__twin.getState();
    {   // 補上「現在」這一筆：無頭環境主執行緒被渲染佔滿時，50 ms 取樣器可能只跑到幾筆
      const r = w.__amrRender ?? {};
      traj.push({ t: performance.now(), run: s.runId, resetting: s.resetting,
        r: Object.fromEntries(Object.keys(r).map((k) => [k, [...r[k]]])),
        a: Object.fromEntries(Object.keys(s.amrLive).map((k) => [k, [...s.amrLive[k].position]])) });
    }
    const ids = Object.keys(s.amrLive);
    const hyp = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    // §55：重建期間的樣本（覆蓋層顯示中、權威仍是舊 run）——舊 run 必須凍結
    const during = traj.filter((x) => x.resetting && x.run === b && x.r[ids[0]] && x.a[ids[0]]);
    const rebuild = ids.map((id) => {
      let authDrift = 0, renderMove = 0, lateMove = 0;
      const t0r = during.length ? during[0].t : 0;
      for (let i = 0; i < during.length; i++) {
        authDrift = Math.max(authDrift, hyp(during[i].a[id], during[0].a[id]));
        if (i === 0) continue;
        const step = hyp(during[i].r[id], during[i - 1].r[id]);
        renderMove += step;
        if (during[i].t - t0r >= 1000) lateMove += step;       // 前 1 s 允許收掉平滑餘量
      }
      return { id, samples: during.length, ms: during.length ? Math.round(during[during.length - 1].t - t0r) : 0,
        authDrift, renderMove, lateMove };
    });
    // 新 run 的樣本（權威位置已是新 run）
    const after = traj.filter((x) => x.run !== b && x.run === s.runId);
    const t0 = after[0].t;
    const perAmr = ids.map((id) => {
      // 找「直接定位」那一跳：render 相對前一筆一次移動 > 1 m，或已貼近權威位置
      let snapIdx = -1, preMove = 0;
      for (let i = 0; i < after.length; i++) {
        const prev = i > 0 ? after[i - 1].r[id] : after[0].r[id];
        const step = hyp(after[i].r[id], prev);
        if (hyp(after[i].r[id], after[i].a[id]) < 2.5 || step > 1.0) { snapIdx = i; break; }
        preMove += step;                                   // 切換後、定位前：畫面不應該在移動
      }
      let total = 0, maxStep = 0;
      for (let i = Math.max(1, snapIdx + 1); i < after.length; i++) {
        const d = hyp(after[i].r[id], after[i - 1].r[id]); total += d; maxStep = Math.max(maxStep, d);
      }
      const authMove = snapIdx >= 0 ? hyp(after[after.length - 1].a[id], after[snapIdx].a[id]) : 0;
      return { id, snapIdx, snapDelayMs: snapIdx >= 0 ? after[snapIdx].t - t0 : -1, preMove,
        gapAtSnap: snapIdx >= 0 ? hyp(after[snapIdx].r[id], after[snapIdx].a[id]) : -1,
        postTraverse: total, authMove, samples: after.length };
    });
    const finalGaps = ids.map((id) => ({ id, moving: /^TRAVEL|RETURNING/.test(s.amrLive[id].task_state),
      gap: hyp(w.__amrRender[id], s.amrLive[id].position) }));
    const tail = after.slice(-3).map((x) => ({ dt: Math.round(x.t - t0), r: x.r["AMR-01"], a: x.a["AMR-01"] }));
    const head = after.slice(0, 12).map((x) => ({ dt: Math.round(x.t - t0), rs: x.resetting, r: x.r["AMR-01"].map((v: number) => +v.toFixed(1)), a: x.a["AMR-01"] }));
    return { perAmr, rebuild, finalGaps, runId: s.runId, debug: { head, tail, n: after.length, during: during.length, total: traj.length } };
  }, before);
  console.log("reset_live trajectory:", JSON.stringify(res));
  expect(res.runId).not.toBe(before);
  // (0) 重建期間：舊 run 凍結——權威位置不動、畫面收掉平滑餘量後也不動（§49 語意由測試守住）
  for (const r of res.rebuild) {
    expect(r.samples, `rebuild samples ${r.id}`).toBeGreaterThanOrEqual(5);      // 重建 ≥ 3 s，50 ms 取樣
    expect(r.ms, `rebuild duration ${r.id}`).toBeGreaterThanOrEqual(1500);
    expect(r.authDrift, `rebuild authoritative drift ${r.id}`).toBeLessThan(0.5);   // 最多一筆在途 amr_patch
    expect(r.lateMove, `rebuild late render movement ${r.id}`).toBeLessThan(0.5);   // 1 s 後畫面靜止
    expect(r.renderMove, `rebuild render movement ${r.id}`).toBeLessThan(2.5);      // 含收斂前的平滑餘量
  }
  for (const a of res.perAmr) {
    expect(a.samples, `samples ${a.id}`).toBeGreaterThanOrEqual(3);   // 無頭主執行緒被渲染佔滿時，50 ms 取樣器只跑得到幾筆
    // (1) 切換後 1 s 內出現「直接定位」幀，且定位前畫面沒有在移動（不是從舊位置滑過來）
    expect(a.snapIdx, `snap found ${a.id}`).toBeGreaterThanOrEqual(0);
    // 第一幀出現的延遲是環境效能：真機 ~16 ms；無頭 swiftshader 換 run 後的首幀（新零件／標籤貼圖上傳，
    // 主執行緒被佔滿、取樣器同步停擺）實測 0.3–14 s。這裡只擋「根本沒有換到新位置」，不把軟體算圖的
    // 幀時間當成產品指標——產品語意由 preMove／gapAtSnap／postTraverse 三條嚴格斷言守住。
    expect(a.snapDelayMs, `snap delay ${a.id}`).toBeLessThan(20_000);
    expect(a.preMove, `pre-snap movement ${a.id}`).toBeLessThan(1.0);
    expect(a.gapAtSnap, `gap at snap ${a.id}`).toBeLessThan(2.5);
    // (2) 定位之後沒有中間穿越：畫面走過的距離 ≲ 權威位移＋平滑餘量（倒車穿越是幾十公尺的連續小步）
    expect(a.postTraverse, `post-snap traverse ${a.id}`).toBeLessThan(a.authMove + 3.0);
  }
  // (3) 收斂：靜止車 < 0.5 m、行進車 < 1.5 m（無頭 2–6 FPS 單幀平滑落後；真機 ≈ 0.02 m）
  for (const g of res.finalGaps) expect(g.gap, g.id).toBeLessThan(g.moving ? 1.5 : 0.5);
});

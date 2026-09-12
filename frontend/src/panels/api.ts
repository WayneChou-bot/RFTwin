/** 輕量 API helper（review P2-6 / §43）：response.ok 檢查 + 失敗回 null，
 *  後端未啟動時不產生 unhandled rejection，畫面退回 placeholder。
 *  LOCAL_DEMO 模式（§43.5）：資料分頁改讀 Python 預產的 aux fixture，
 *  需要權威引擎的端點（scenarios/copilot/inject）回 null → UI 顯示停用提示。
 *  （完整 typed client／AbortController／retry 對本作品規模屬過度工程，見 README。） */
import { useTwin } from "../state/store";

let demoAux: any = null;

/** demo.ts 載入 fixture 後註冊；LOCAL_DEMO 模式下 getJson 由此供資料。 */
export function setDemoAux(aux: any): void {
  demoAux = aux;
}

function demoRoute(url: string): any {
  if (!demoAux) return undefined;
  if (url.startsWith("/api/maintenance")) return demoAux.maintenance;
  if (url.startsWith("/api/energy/breakdown")) return demoAux.energy_breakdown;
  if (url.startsWith("/api/energy/opportunities")) return demoAux.energy_opportunities;
  if (url.startsWith("/api/flow/insight")) return demoAux.flow_insight;
  if (url.startsWith("/api/flow/history")) return demoAux.flow_history;
  if (url.startsWith("/api/amr")) return demoAux.amr;
  if (url.startsWith("/api/inspection/recent")) return demoAux.inspection_recent;
  if (url.startsWith("/api/vision/metrics")) return demoAux.vision_metrics;
  if (url.startsWith("/api/scenarios")) return demoAux.scenarios;
  if (url.startsWith("/api/copilot/suggestions")) return [];
  return undefined;               // 其他端點：離線不可用 → null
}

export async function getJson<T = any>(url: string): Promise<T | null> {
  if (useTwin.getState().mode === "LOCAL_DEMO") {
    const d = demoRoute(url);
    return d !== undefined ? (JSON.parse(JSON.stringify(d)) as T) : null;
  }
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function postJson<T = any>(url: string, body?: unknown): Promise<T | null> {
  if (useTwin.getState().mode === "LOCAL_DEMO") return null;   // §43.4 需權威引擎
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

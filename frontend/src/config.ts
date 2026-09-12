/** 後端位址（§57）。預設空字串＝同源（單容器部署、vite dev/preview proxy）。
 *  前端另掛（Vercel）而後端在 Render 時，建置期設定 `VITE_API_BASE=https://<service>.onrender.com`；
 *  REST 走 `apiUrl("/api/…")`，WebSocket 走 `wsUrl()`（http→ws、https→wss）。
 *  後端需以 `TWIN_CORS_ORIGINS` 明示前端 Origin（§53 預設同源，跨站一律拒）。 */
const RAW = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE ?? "").trim();
export const API_BASE = RAW.replace(/\/+$/, "");

export function apiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}

export function wsUrl(): string {
  if (API_BASE) return API_BASE.replace(/^http/i, "ws") + "/ws";
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

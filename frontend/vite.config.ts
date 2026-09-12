import { createLogger, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/* Backend 未啟動時 /api 轉發會 ECONNREFUSED：這是 §43 的正常路徑（前端落到
 * LOCAL_DEMO 並在背景重試），連線狀態已由 Header badge 呈現——不再刷
 * "http proxy error" 日誌（dev 與 preview／e2e 皆適用）。其他錯誤照常輸出。 */
const logger = createLogger();
const rawError = logger.error;
logger.error = (msg, opts) => {
  if (typeof msg === "string" && msg.includes("http proxy error")) return;
  rawError(msg, opts);
};

/* backend port：`npm run dev:all`（scripts/dev_all.mjs）探測可用 port 後以 TWIN_PORT
 * 傳入；手動啟動時預設 8000（`TWIN_PORT=8010 npm run dev` 可改）。 */
const backendPort = process.env.TWIN_PORT || "8000";
/* xfwd：代理附上 X-Forwarded-Host（瀏覽器看到的 host），後端 §53 同源檢查以此比對 Origin。 */
const proxy = {
  "/api": { target: `http://localhost:${backendPort}`, xfwd: true },
  "/ws": { target: `ws://localhost:${backendPort}`, ws: true, xfwd: true },
};

export default defineConfig({
  plugins: [react()],
  customLogger: logger,
  server: { proxy },
  preview: { proxy },
  build: { chunkSizeWarningLimit: 1500 },
});

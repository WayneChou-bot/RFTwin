/** §37 viewport 回歸。
 *  跑法：`npm run build && npm run test:e2e`（首次先 `npx playwright install chromium`）。
 *  以 `vite preview` 服務 dist；不需要 Backend——前端會落到 LOCAL_DEMO，
 *  正好同時驗證 §43 離線啟動。 */
import { defineConfig } from "@playwright/test";

const port = 4173;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  retries: 0,
  // §53：無頭 WebGL（swiftshader）多個 worker 會互搶 CPU，Local Demo 的 fixture
  // 推進逾時 → Reset 案例偶發失敗。CI 固定 1 worker；本機 2；不做檔案內平行。
  workers: process.env.CI ? 1 : 2,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
    // 軟體算圖環境（CI／無 GPU）也能建立 WebGL context
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM || undefined,
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: `npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

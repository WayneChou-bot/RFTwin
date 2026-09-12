# 部署（§50）

一個容器就夠：Python 後端同時服務 API／WebSocket 與前端 `dist`（含離線 demo fixture）。

## 本機驗證

```bash
docker build -t robot-factory-twin .
docker run -p 8000:8000 robot-factory-twin
# → http://localhost:8000 （首次啟動 pre-roll 4h 模擬約 5–10 s；期間 /api/health 回 503）
```

## Render（免費方案可用）

1. 推上 GitHub，Render → New → Blueprint → 選 repo（會讀 `render.yaml`）。
2. 部署完成後前端與 API 同源，`TWIN_CORS_ORIGINS` 留空即可——留空＝**只接受同源**（§53），不是全放行。
3. 免費方案閒置會冷啟動（約 50 s + pre-roll）；`/api/health` 在模擬迴圈停擺 > 10 s 時回 503，Render 會自動重啟。

## Vercel 前端 ＋ Render 後端（分開部署）

前端是靜態檔、後端是常駐進程（100 ms ticker ＋ WebSocket），Vercel 只能放前端；後端放 Render。
兩邊各設一個變數即可：

| 位置 | 設定 |
|---|---|
| **Render**（Web Service，Docker，讀 `render.yaml`） | 環境變數 `TWIN_CORS_ORIGINS=https://<your-app>.vercel.app`（前端的 Origin，完整含 scheme、不含路徑；多個以逗號分隔）。未設＝只接受同源，跨站一律 403／WebSocket 1008 |
| **Vercel**（Root Directory `frontend`、Framework Vite、Build `npm run build`、Output `dist`） | 環境變數 `VITE_API_BASE=https://<service>.onrender.com`（建置期讀入；REST 走 `${VITE_API_BASE}/api/…`，WebSocket 自動改 `wss://…/ws`） |

行為：Vercel 頁面立刻開（靜態），此時 Render 若在冷啟動，Header 先顯示 **LOCAL DEMO**（離線回放），
後端醒來後橫幅提示「Backend is now available. Switch to Live?」，按一下即切 LIVE——不會假裝連線。
Vercel 的 preview deployment 網域每次不同，要測 preview 就把該網域也加進 `TWIN_CORS_ORIGINS`。
本機驗證跨站設定：`TWIN_CORS_ORIGINS=http://localhost:4174 uvicorn … --port 8051`，
`VITE_API_BASE=http://localhost:8051 npm run build && npx vite preview --port 4174`。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `TWIN_CORS_ORIGINS` | （空） | 逗號分隔的允許 Origin。**空＝同源**：只接受無 Origin 或 Origin host == Host 的 POST／WebSocket；設定後只接受名單內 Origin（403）。前端另掛網域（Vercel）時必填 |
| `VITE_API_BASE`（前端，建置期） | （空＝同源） | 後端位址 `https://<service>.onrender.com`；空字串時 `/api`／`/ws` 走同源（單容器或 vite proxy） |
| `TWIN_ALLOW_NO_ORIGIN` | `0` | `1` 放行無 Origin 的請求（curl／腳本） |
| `TWIN_RATE_LIMIT` | `1` | `0` 關閉每 IP 限流（本機開發） |
| `TWIN_MAX_BODY_BYTES` | `524288` | REST body 上限（以實際 bytes 計） |
| `TWIN_HEALTH_STALL_S` | `10` | 模擬迴圈多久未推進即回 503 |

## 防護（`apps/factory_backend/guard.py`）

| 防護 | 預設 |
|---|---|
| Rate limit（每 client IP，記憶體內，10 分鐘閒置回收） | 改變狀態 20 次/分（simulation／failures／safety／alerts）· AI 10 次/分（copilot／vision）· What-if 4 次/分（scenarios／energy whatif）→ `429` |
| Origin 檢查 | 預設同源；`Sec-Fetch-Site: cross-site／same-site` 一律拒 → `403`（WebSocket 在 accept 前檢查，1008） |
| WebSocket 上限 | `TWIN_WS_MAX`（總 100）、`TWIN_WS_MAX_PER_IP`（6）→ 1013；上行訊息 > `TWIN_WS_MAX_MSG_BYTES`（4 KB）→ 1009；單 client send 逾時 `TWIN_WS_SEND_TIMEOUT_S`（1 s）→ 丟棄 |
| What-if 歷史 | `TWIN_SCENARIO_KEEP`（20）；Reset 清空 |
| Body 大小 | 512 KB，在 ASGI receive 層以實際 bytes 計算（造假 Content-Length／chunked 都擋）→ `413` |
| Health | 模擬迴圈停擺 → `503`；單輪例外（如序列化失敗）記錄後續行，不讓模擬死掉（`loop_errors`／`last_error` 於 health 可見） |
| Client IP | `X-Forwarded-For` 依 `TWIN_XFF`：`first`（預設；Render 官方說明真實 client 在第一段）、`last`（自建代理會覆寫 XFF 時）、`none`（不信任 XFF） |

讀取端點（`/api/health`、snapshot、events、KPI…）與 WebSocket 不受限。

## 誠實邊界

公開 Demo 是**一份共享的模擬**：所有訪客看同一座工廠、可以注入同樣的故障（這正是 Demo 的意義）。稽核紀錄在記憶體，重啟即清空；Reset 會影響所有連線中的訪客。

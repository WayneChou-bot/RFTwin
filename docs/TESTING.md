# Testing

## 一鍵（CI 入口）

```bash
npm run ci      # schemas → engine fixture → AJV → types diff → pytest
```

`.github/workflows/ci.yml` 跑同一條管線，再加前端 build、離線 Playwright（Local Demo）與
Live Playwright（另起 uvicorn :8010）。任何 schema／types／layout 副本漂移都會讓 CI 失敗（ADR-003）。
repo 建立後在 README 加真實徽章：`[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/ci.yml)`。

## pytest（156 項）

```bash
pip install -r requirements.txt
PYTHONPATH=packages python -m pytest tests/ -q     # 約 4–5 分鐘（tests/conftest.py 設定 TWIN_RATE_LIMIT=0 等）
```

| 檔案 | 項數 | 涵蓋 |
|---|---|---|
| test_fixture | 10 | canonical fixture 守恆、KPI 公式、provenance／parameter hash |
| test_engine | 8 | 狀態機、確定性（state hash）、dump/load 含 RNG |
| test_api | 19 | snapshot／after_seq／WS 首訊息、amr_patch、control 廣播、Reset 凍結與 registry、what-if 邊界與單飛、注入時長邊界、scenario retention |
| test_failures | 12 | Demo B/C 事件順序與時限、修復恢復 |
| test_whatif | 9 | 隔離引擎、Live state hash 不變、12 指標表、第一分歧 |
| test_copilot | 18 | 意圖路由、規則式回答、Ollama fallback |
| test_vision | 7 | 合成影像、ONNX 推論、真值對照 |
| test_amr／test_intralogistics | 2／8 | 派工、任務狀態機、SLA→MATERIAL_LOW→STARVED |
| test_energy | 8 | per-asset 功率積分守恆、機會、能源 what-if |
| test_demo_fixture | 5 | Local Demo fixture 完整性 |
| test_sidezone／test_facility | 5／9 | 收出貨閉環、廠務設備 |
| test_traffic | 15 | 2h 最小間距、讓行／改道／續行、路線連續性、障礙驗證、無安全路徑（封死所有車道 422／NO_SAFE_PATH 單一事件與恢復） |
| test_layout | 3 | 佈局 JSON 單一來源（引擎＝前端副本） |
| test_guard | 11 | rate limit、Origin（名單／預設同源／Sec-Fetch-Site／X-Forwarded-Host）、body 上限、XFF 取段、WebSocket（accept 前 Origin、連線上限、訊息大小、慢連線逾時→關閉並釋放名額、並行 fan-out、首份 snapshot 逾時不卡廣播） |
| test_dispatch_perception | 6 | Decision Record 涵蓋、rank 1 指派、決定性、感知幾何、wire |

## Playwright e2e（13 項）

```bash
cd frontend && npm ci && npx playwright install chromium
npm run build && npm run test:e2e                       # 10 項離線（Local Demo），3 項跳過；CI 1 worker／本機 2（無頭 WebGL 互搶）
E2E_LIVE=1 TWIN_PORT=8010 npx playwright test i18n reset_live sync   # 3 項需 Live backend
```

離線：viewport 5（1440×900／1280×720／1279×630／1366×768，不整頁捲動）、Reset 2、障礙繞行 1、
感知列＋派工卡 1、介面語言 1（預設英文→切繁中：六個視圖標題／內容、右欄分頁、KPI 列、`<html lang>`、Analyze 結果隨語言重算、
tablist 無障礙名稱、重新整理後記住；引擎產生的派工理由句維持英文）。Live：注入回饋訊息隨語言切換（接受／拒絕兩路徑、aria-label）、跨分頁控制同步＋回前景重抓、Live Reset 軌跡（重建期間舊 run 凍結：權威漂移 < 0.5 m、畫面 1 s 後靜止；
切換後首幀即在新位置、定位前不移動、定位後無中間穿越、收斂 < 0.5／1.5 m）。

軟體算圖環境（CI／無 GPU）用 `--use-angle=swiftshader`，只有個位數 FPS；e2e 只量位置與狀態，
不量觀感。

## 測試掛勾（只在瀏覽器）

`window.__twin`（store）、`window.__amrRender`（畫面上的 AMR 位置）、`window.__selectAmr(id)`。

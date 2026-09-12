# Architecture & Developer Guide（twin-platform）

> 這份是給要讀程式碼、跑測試、改引擎的人看的；作品展示頁是根目錄 `README.md`。
> 設計決策摘要（ADR-001～009）見本檔「原則」一節；程式碼註解裡的 §n 是作者內部設計筆記的章節編號，
> 只作為交叉參照，不影響閱讀。

## 系統概觀

```
config/simulation_parameters.yaml ─┐            config/factory_layout.json ─┐
                                   ▼                                        ▼
packages/domain_factory  ── FactoryEngine（確定性、tick 100 ms、dump/load 含 RNG）
        │  models.py（Pydantic）──► schemas/*.json ──► frontend/src/types/*.ts（單向生成）
        ▼
apps/factory_backend（FastAPI）── REST（inject／what-if／copilot／audit）＋ WebSocket
        │        snapshot 1 Hz ＋ event ＋ amr_patch 10 Hz ＋ control
        ▼
frontend（Vite + React + R3F）── 3D 工廠、面板、Local Demo 回放（fixture，不是第二引擎）
```

原則：**後端權威**（ADR-001）——前端不決定任何生產結果；**schema 單向**（ADR-003）——改
`models.py` 或 YAML 後由 `npm run ci` 重新產生，`schemas/`、`generated.ts`、`src/layout/factory_layout.json`
禁止手改；**確定性**——同 seed 同結果，state hash 為測試背書（ADR-005）；**參數與佈局有 hash**
（ADR-009）進 provenance。

關於「與 WareTwin 共用 runtime」：`packages/twin_runtime_core/`（clock／rng／event bus／audit）是依
這個目標設計的，但目前只有 Robot Factory 使用；WareTwin 尚未改用。公開敘述一律用 *inspired by*。

## 目前狀態

| 項目 | 位置 | 說明 |
|---|---|---|
| twin-runtime-core | `packages/twin_runtime_core/` | clock、rng、event bus、audit（ADR-001；設計為可共用，目前僅本專案使用） |
| FactoryEngine | `packages/domain_factory/engine.py` | 權威引擎：狀態機、dispatcher、守恆、pre-roll、dump/load 含 RNG（ADR-005/008） |
| Wire serializer | `packages/domain_factory/serialize.py` | Engine → SnapshotMessage |
| Backend | `apps/factory_backend/main.py` | FastAPI + WS：snapshot、events?after_seq、pause/speed/reset（ADR-004） |
| Pydantic models | `packages/domain_factory/models.py` | wire schema 的唯一來源（ADR-003） |
| 參數載入 + hash | `packages/domain_factory/params.py` | ADR-009 `parameter_hash` |
| 模擬參數 | `config/simulation_parameters.yaml` | 唯一參數來源（factory-mvp-v13） |
| 場地佈局 | `config/factory_layout.json` | 唯一幾何來源（factory-layout-v1）；`scripts/sync_layout.py` 同步到前端 |
| 部署 | `Dockerfile`、`render.yaml`、`docs/DEPLOY.md` | 單容器（backend 服務 dist）；防護層 `apps/factory_backend/guard.py` |
| JSON Schema | `schemas/*.schema.json` | 由 models 產生，勿手改 |
| TS types | `frontend/src/types/generated.ts` | 由 Schema 產生，勿手改 |
| Canonical fixture | `fixtures/snapshot.live-001.json` | **由 Engine pre-roll 輸出**（`scripts/dump_snapshot.py`）|
| 3D 前端 | `frontend/src/` | Vite+React+R3F：WS client（gap 補送/run_id reset）、程式化六軸手臂、Cell/Conveyor/AMR/Buffer、Rendering modes |
| 介面語言 | `frontend/src/i18n/index.ts` | `en`／`zh` 字典（TypeScript 保證鍵一致）、`useT()`（元件）／`t()`（事件處理）、`useLang`（localStorage `twin.lang`、預設依瀏覽器）。只翻 UI；引擎輸出（事件、派工理由、Copilot 回答、what-if 指標名）與 3D 場景內標牌維持英文 |
| 前端建置 | `frontend/dist/` | 已編譯；`uvicorn` 啟動即在 http://localhost:8000 服務 |
| 測試 | `tests/` | 見 `docs/TESTING.md`（pytest 各檔項數與 e2e 清單；數字以該檔為準） |

## 指令

```bash
npm install                 # ajv / json-schema-to-typescript
pip install pydantic pyyaml pytest --break-system-packages

npm run ci                  # schemas → engine fixture → AJV → types diff → pytest（CI 入口）

# 啟動（pre-roll 4 模擬小時：容器/新桌機 ~3.5 s、較舊筆電 ~10 s，依硬體；完成後從 10:00 開始 live 推進；瀏覽器開 http://localhost:8000）
uvicorn apps.factory_backend.main:app --port 8000

# 前端開發模式（另開一個終端；vite 會 proxy /api 與 /ws 到 :8000）
cd frontend && npm install && npm run dev     # http://localhost:5173

# 一鍵啟動（後端 --reload + Vite；同 start_robot_factory.bat / Start-RobotFactory.ps1）
npm run dev:all
```

**畫面停在 Local Demo、不是 LIVE？** 先看 `[api]` 那行有沒有起來。Windows 常見
`[WinError 10013] 以一種存取權限不允許的方式做了一個存取通訊端的嘗試`：port 8000 被
Hyper-V／WSL2 的保留區段吃掉（`netsh interface ipv4 show excludedportrange protocol=tcp`
可看到），uvicorn 綁不到就退出，前端只好用 fixture 回放。`npm run dev:all`
（`scripts/dev_all.mjs`）會自動探測 8000 → 8010 → 8080 → 8800 → 18000 並把同一個 port
交給 uvicorn 與 Vite proxy（環境變數 `TWIN_PORT`）；要指定就 `set TWIN_PORT=8010`
（PowerShell：`$env:TWIN_PORT="8010"`）再跑。手動兩個終端啟動時，uvicorn 的 `--port`
與 Vite 的 `TWIN_PORT` 要一致。

修改流程（ADR-003 單向）：改 `models.py` 或 YAML → `npm run ci` 會重新產生並在
types 不同步時失敗；**禁止手改 `schemas/`、`generated.ts`。**

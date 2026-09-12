# Demo 腳本（給人看的版本）

> 每一條都是「**做什麼 → 看什麼**」。全部效果由 Python 權威引擎決定，前端只呈現（ADR-001）。
> 先 `npm run dev:all`（或 `start_robot_factory.bat`），開 http://localhost:5173 ，Header 徽章要是 **LIVE**。
> 若是 **LOCAL DEMO**：後端沒起來（多半是 port 8000 被 Windows 保留，見 README「排錯」），
> 只能看回放，Inject／What-if／Copilot／Audit Log 會鎖住。

> 介面語言：Header 右上 **中／EN** 切換（預設跟瀏覽器語言、會記住）。給國外的人看直接切 EN；事件訊息、派工理由、
> Copilot 回答是引擎輸出，兩種語言下都維持英文（工程日誌語意）。

## 30 秒講稿

> 這是一條四個製程 Cell、12 台機械手臂、2 台 AMR 的機器人工廠數位分身。畫面上每一個數字、
> 每一台車的位置都來自後端的確定性模擬引擎——同一個 seed 重跑會得到一模一樣的結果。
> 你可以注入故障、看瓶頸怎麼移動；問「如果 R-09 壞 30 分鐘」，它會在隔離的分支裡跑完
> Baseline 與 Scenario，給你 12 項指標的差異與第一個分歧事件；AMR 會偵測、讓行、改道，
> 每次派工都留下「為什麼選這台車」的紀錄。斷線時畫面切到本機回放，不假裝還在連線。

## 12 條操作

| # | 操作 | 看什麼 |
|---|---|---|
| 1 | Header 點 **⟲ Reset** | 畫面出現「Rebuilding run…」覆蓋（3–10 s，依硬體）；sim 時鐘回到 **10:00**、`run_id` 變成 LIVE-002…；AMR **直接**出現在新位置，不會倒車穿過工廠（§49）。 |
| 2 | 右側 **Inject → C-03 Conveyor Jam** | 3D 內 C-03 輸送帶停、紅色 Stack Light；~50 s 內 Machine Tending 變 **BLOCKED**、Inspection **STARVED**；Alerts 出現 HIGH；修復後 <10 s 恢復（Demo B 時序）。 |
| 3 | **Inject → Light Curtain — Assembly** 再按 **🔁 Reset CELL-ASSEMBLY** | 光柵觸發 → Cell 安全停止（機械手臂停在原位、圍籬燈紅）；到期後 **不會自動恢復**，要按 Reset（SAFETY_RESET 進 Audit，actor=operator）。 |
| 4 | **Inject → Obstacle — West corridor** | 走廊出現護欄＋三角錐＋兩圈（實體半徑／規劃淨空）；來車 **AMR_DETOUR** 事件、路線改走橙色虛線的備援走廊（§48）。再用同頁的 **Custom obstacle** 表單按 **@AMR-01**（填入該車目前座標）→ **Place**：引擎以 422 拒絕並說明「距 AMR 太近」（§49／§52）。把半徑填 4、z 填 16.1 → 422「would block every corridor lane」（§53）；兩個各 1 m 的障礙分別放在 (0, 14.3) 與 (0, 17.9) → 受影響的 AMR 變成紅色虛線 **NO SAFE PATH**、只發一筆 AMR_PATH_BLOCKED，障礙到期後 AMR_PATH_CLEAR 續行。 |
| 5 | 3D 點一台 **AMR**（或按 `AMR` 鏡位再點車） | 左下卡片：state／traffic／route 進度／**perception**（CLEAR·CAUTION·STOPPED、前方最近距離、感測到的車與障礙＋方位）／**dispatch**（這台為什麼被選或落選）。車周圍畫出 ±45° 扇形（2.0 m safe 實心、2.6 m 遲滯外緣）與到每個物體的射線（§51）。 |
| 6 | **Inject → AMR-02 Sensor Stop** 後選 AMR-01 | AMR-02 前方畫紅弧（讓行中）；AMR-01 若被擋，卡片 perception 變 **STOPPED**、traffic **YIELDING**，6 s 後 **AMR_REROUTED**（§47）。 |
| 7 | 右側 **Audit → Dispatch Decisions** | 最近 8 筆派工：規則 `priority → FIFO → 偏好類 → 最近 → id`、選中理由句、點開看每台候選的距離／電量／偏好／rank／落選原因；**DEFERRED** 代表當時沒有適格的車（§51）。Local Demo 也看得到（來自 snapshot）。 |
| 8 | **What-if → What if R-09 fails for 30 min?** | 12 項指標表：Baseline／Scenario／Δ／Δ%（方向感知的紅綠）、**第一個分歧事件**與 tick；Live 完全不受影響（state hash 不變）。再按 **▶ Apply scenario to LIVE** 把同一注入套進 Live（審計 SCENARIO_APPLIED）（§50）。對照 R-06 同樣 30 min → Δ≈0：冗餘吸收、瓶頸未受影響。 |
| 9 | 頂部 **Production Flow** | 三層：KPI 條／動態流程圖（流量、佇列、守恆式）／分析圖；Lead time、Buffer 滿載時間、cycle 分布（§40）。 |
| 10 | 頂部 **Energy** → 3D 開 **Energy** overlay | 每資產功率、需量上限線、Opportunities（附證據：idle 分鐘 × 功率）；3D 地板熱區 = 各 Cell 即時功率（§41／§46）。**Inject → Compressor Fault**：焊接站失去壓縮空氣 → utility 故障、廠務區狀態燈變紅（§45.8）。 |
| 11 | 點 3D 內任一 **工件**（輸送帶／Buffer 上的小方塊） | Part Trace 卡：製程路線步驟、lifecycle／quality、目前位置、年齡；Inspection 站選 R-11/R-12 看 Camera Feed（ONNX 判定 vs 真值）（§46／Vision）。 |
| 12 | 開第二個分頁，在那邊按 **⏸**／**5×** | 第一個分頁的按鈕狀態跟著變（控制以後端為準）；把分頁切到背景再切回來 → 自動重抓一份權威 snapshot（§51）。關掉後端 → 15 s 後 **STALE**、再 → **LOCAL DEMO** 回放，徽章與橫幅說明清楚（§43）。 |

## 常見狀況

- **徽章是 LOCAL DEMO**：後端沒起來或連不上。看終端 `[api]` 行；Windows `WinError 10013` = port 被保留，`npm run dev:all` 會自動換 port（或 `set TWIN_PORT=8010`）。
- **Copilot 回答是模板句**：本機沒有 Ollama（`OLLAMA_URL`），自動退回確定性模板；回應會標 `nl_source: template`。事實層不變。
- **FPS 低**：Header 右側切 **Balanced／Performance**；無頭／軟體算圖環境（CI）本來就只有個位數 FPS，10 Hz 平滑要在真機看。
- **Reset 按了沒反應**：正在重建（按鈕 busy）或後端 409（另一個 reset 進行中）；等覆蓋消失。
- **429 rate limited**：公開部署的防護層（每 IP 改狀態 20／分、What-if 4／分）；本機開發 `TWIN_RATE_LIMIT=0`。
- **409 a what-if is already running**：同時只跑一個 What-if（§52）；等前一個回來再按。
- **409 …branched from LIVE-00n**：Reset 之後舊的 What-if 不能 Apply 到新 run，重跑一次即可。

## 一句話的誠實邊界

Local Demo 是引擎預先產生的 5 分鐘確定性回放，不是第二套引擎；斷線後從回放起點開始，不接續當前狀態（ADR-001 的取捨）。

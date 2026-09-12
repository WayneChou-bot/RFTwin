"""FactoryEngine — Robot Factory Domain Pack 的權威模擬引擎（§10–§13、§25）。

- 固定 tick（100 ms）驅動；牆鐘只出現在 generated_at。
- 所有集合走固定順序；唯一 RNG 消費點是檢測判定（"process" stream）。
- dump_state()/load_state() 為 JSON-safe，含 RNG internal state（ADR-005）。
- 守恆式（ADR-008）：created == wip + good_completed + scrap，check_conservation() 驗證。
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Optional

from twin_runtime_core import AuditLog, EventBus, RngService, SimulationClock
from .params import load_params, parameter_hash

ENGINE_VERSION = "0.20.0"
DOMAIN_VERSION = "factory-1.0"
SCHEMA_VERSION = "1.0"

CELL_ORDER = ["welding", "assembly", "machine_tending", "vision_inspection"]

# §39 Intralogistics：每 Cell 一種耗材 SKU；每次 cycle start 消耗 1 單位
RACK_SKU = {"welding": "WELD-WIRE", "assembly": "FASTENER-KIT",
            "machine_tending": "CNC-INSERT", "vision_inspection": "QA-TRAY"}
RACK_ORDER = [RACK_SKU[k] for k in CELL_ORDER]   # deterministic SKU tie-break
# §39.4 任務狀態機的相位順序（時長取自 intralogistics.fleet）
TASK_PHASES = ["TRAVEL_TO_PICKUP", "DOCKING_PICKUP", "LOADING",
               "TRAVEL_TO_DROPOFF", "DOCKING_DROPOFF", "UNLOADING", "RETURNING"]
TASK_PRIORITY = {"CELL_REPLENISH": 1, "RAW_REPLENISH": 1, "INBOUND_RESTOCK": 1,
                 "FG_COLLECT": 2}
SLOW_DECIMATION = 5            # 慢速子系統（cell state／能源）每 0.5 s（決定性）；AMR 自 §50 起每 tick
DECISION_RING = 20               # §51 派工紀錄環（snapshot 帶最近 N 筆）
AMR_KPI_ZERO = {"tasks_completed": 0, "busy_sec": 0.0, "charge_sec": 0.0,
                "dock_wait_sec": 0.0, "distance_m": 0.0, "energy_kwh": 0.0,
                "yield_sec": 0.0}      # §47 交通讓行時間
CELL_IDS = {k: f"CELL-{k.upper()}" for k in CELL_ORDER}
OPERATION = {"welding": "WELDING", "assembly": "ASSEMBLY",
             "machine_tending": "MACHINING", "vision_inspection": "INSPECTION"}
CONVEYORS = ["C-01", "C-02", "C-03"]          # cell i → cell i+1

# §50 佈局單一來源：AMR 空間模型的幾何（dock／充電位／走廊／障礙預設位置／樓面
# 範圍）全部來自 config/factory_layout.json（domain_factory/layout.py），前端場景讀同
# 一份 JSON 的同步副本——不再以常數鏡射兩邊（WareTwin 借鏡）。
from .layout import (AMR_CORRIDOR_Z, AMR_DOCKS, AMR_HOME, EVADE, FLOOR,  # noqa: E402,F401
                     LAYOUT_HASH, LAYOUT_ID, OBSTACLE_SITES)

# §9 cycle phase 表：(phase 名, 秒)。machine_tending 中段為 WAITING_MACHINE。
def _scaled(names_fracs: list[tuple[str, float]], total: float) -> list[tuple[str, float]]:
    return [(n, f * total) for n, f in names_fracs]

PHASES = {
    "welding": _scaled([("PART_DETECTED", .05), ("MOVE_TO_APPROACH", .15), ("POSITIONING", .15),
                        ("WELDING", .45), ("INSPECTION", .10), ("RETURN_HOME", .10)], 40),
    "assembly": _scaled([("PICK_COMPONENT", .15), ("MOVE_TO_FIXTURE", .15), ("ALIGN", .10),
                         ("INSERT", .15), ("FASTEN", .25), ("TORQUE_CHECK", .10),
                         ("RELEASE", .10)], 40),
    "machine_tending": [("PICK_RAW_PART", 4), ("OPEN_MACHINE", 2), ("LOAD_MACHINE", 3),
                        ("CLOSE_MACHINE", 1), ("WAITING_MACHINE", 27),
                        ("OPEN_MACHINE", 2), ("REMOVE_PART", 3), ("PLACE_FINISHED_PART", 3)],
    "vision_inspection": [("PART_ARRIVED", 8), ("CAPTURE_IMAGE", 6), ("INSPECTING", 6),
                          ("PASS_OR_FAIL", 2), ("SORT", 16)],
}


class FactoryEngine:
    def __init__(self, run_id: str = "LIVE-001", seed: int = 42,
                 params: Optional[dict] = None):
        self.params = params or load_params()
        p = self.params
        self.run_id = run_id
        self.provenance = {
            "run_id": run_id, "engine_version": ENGINE_VERSION,
            "domain_version": DOMAIN_VERSION, "schema_version": SCHEMA_VERSION,
            "parameter_set_id": p["parameter_set_id"],
            "parameter_hash": parameter_hash(p), "seed": seed,
            "layout_id": LAYOUT_ID, "layout_hash": LAYOUT_HASH,      # §50
            "initial_snapshot_id": None, "branch_from": None,
        }
        self.clock = SimulationClock(p["tick_ms"], f"2026-08-22T{p['shift']['start']}:00+08:00")
        self.rng = RngService(seed)
        self.bus = EventBus(run_id)
        self.audit = AuditLog(run_id)

        # ---- 靜態拓樸 ----
        self.cells: dict[str, dict] = {}
        for key in CELL_ORDER:
            c = p["cells"][key]
            cyc = sum(c["station_cycle_sec"].values())
            self.cells[key] = {
                "key": key, "cycle": float(cyc),
                "stations": [
                    {"station_id": st, "robot_id": rb,
                     "machine_id": c.get("robot_to_machine", {}).get(rb),
                     "part_id": None, "elapsed": 0.0, "state": "READY",
                     "idle_since": 0, "blocked_time": 0.0, "starved_time": 0.0,
                     "idle_time": 0.0, "busy_time": 0.0, "completions": 0,
                     "fault_kind": None, "fault_until": 0, "fault_dur": 0, "maint": 0,
                     "fault_time": 0.0}
                    for st, rb in zip(c["stations"], c["robots"])
                ],
            }
        b = p["buffers"]
        self.raw_stock = b["raw_material"]["capacity"]          # 匿名庫存；釋放時才建 Part
        self.inter: dict[str, list[str]] = {                     # cell 間 buffer（part_id FIFO）
            "welding_to_assembly": [], "assembly_to_machining": [], "machining_to_inspection": []}
        self.inter_after = {"welding": "welding_to_assembly", "assembly": "assembly_to_machining",
                            "machine_tending": "machining_to_inspection"}
        self.conveyors: dict[str, list[dict]] = {c: [] for c in CONVEYORS}   # {part_id, remaining}
        self.conv_state: dict[str, dict] = {
            c: {"status": "RUNNING", "jam_until": 0, "full_emitted": False} for c in CONVEYORS}
        self.cell_states: dict[str, str] = {k: "RUNNING" for k in CELL_ORDER}
        self.conv_cfg = p["conveyors"]
        self.rework: list[dict] = []                             # {part_id, remaining}
        self.parts: dict[str, dict] = {}                         # 活著的 Part registry
        # ---- §39 Intralogistics：Cell-side Rack / Supermarket / Fleet ----
        il = p["intralogistics"]
        self.racks: dict[str, dict] = {}
        for i, key in enumerate(CELL_ORDER):
            r = il["racks"]
            self.racks[key] = {
                "rack_id": f"RACK-{key.upper()[:4]}", "sku": RACK_SKU[key],
                "capacity": r["capacity"], "qty": r["capacity"],
                "reorder_point": r["reorder_point"], "reserved": 0,
                "batch": r["replenish_batch"], "low_threshold": r["low_threshold"],
                "container_id": f"TOTE-{i + 1:03d}", "last_replenished_time": None,
                "material_low": False, "stockout_sec": 0.0,
                "stockout_since_order": False,
            }
        cap_sku = il["supermarket"]["capacity_per_sku"]
        self.supermarket = {"per_sku": {RACK_SKU[k]: cap_sku for k in CELL_ORDER},
                            "capacity_per_sku": cap_sku, "empties": 0}
        # §44.8：shipped 於 Staging 卸貨才計入；fg_picked = 已離開 FG buffer（在途）
        self.fg_picked = 0
        self.staging_units = 0
        self.outbound_total = 0
        # §45.3/45.4：收貨與出貨事件閉環（取代瞬時外部供應／瞬時出貨）
        self.receiving = {"stage": "IDLE", "sku": None, "qty": 0,
                          "remaining": 0.0, "truck_no": 0}
        self.outbound = {"stage": "IDLE", "remaining": 0.0, "truck_no": 0}
        # §45.8 廠務設備：壓縮機故障（焊接站失去壓縮空氣 → utility_air 故障）
        self.compressor_fault_until = 0
        # §48 空間障礙物（有座標／半徑／時限；路線規劃與移動鉗制皆納入）
        self.obstacles: list[dict] = []
        self._obs_no = 0
        self._n_weld = 0
        self.amrs = [
            {"amr_id": "AMR-01", "status": "IDLE", "task_state": "IDLE",
             "battery": float(p["amr_model"]["battery_start_percent"][0]),
             "task": None, "phase_remaining": 0.0, "phase_total": 0.0,
             "carrying": None, "fault_until": 0,
             "pos": list(AMR_HOME["AMR-01"]), "route": [], "route_kind": "main",
             "yielding": False, "yield_since": 0.0, "yield_event": False,
             "drop_f": 0.0,
             "pref_priority": 1,               # 偏好補料類（§39.2；可互相接替）
             "kpi": dict(AMR_KPI_ZERO)},
            {"amr_id": "AMR-02", "status": "IDLE", "task_state": "IDLE",
             "battery": float(p["amr_model"]["battery_start_percent"][1]),
             "task": None, "phase_remaining": 0.0, "phase_total": 0.0,
             "carrying": None, "fault_until": 0,
             "pos": list(AMR_HOME["AMR-02"]), "route": [], "route_kind": "main",
             "yielding": False, "yield_since": 0.0, "yield_event": False,
             "drop_f": 0.0,
             "pref_priority": 2,               # 偏好 FG／回流類
             "kpi": dict(AMR_KPI_ZERO)},
        ]
        self.amr_queue: list[dict] = []        # 任務物件（priority → FIFO）
        self._task_no = 0
        # §51 派工 Decision Record（WareTwin 借鏡）：每次指派／延後記錄候選、理由、落選原因
        self.decisions: list[dict] = []
        self._decision_no = 0
        self.fleet_kpi = {"on_time": 0, "late": 0, "cancelled": 0,
                          "wait_sec_sum": 0.0, "starvation_logistics_sec": 0.0}

        # ---- §41 Per-asset 能源帳（總能耗 = 各資產積分之和，恆等式由建構保證） ----
        self.assets: dict[str, dict] = {}

        def _asset(aid: str, group: str, cell: str | None) -> None:
            self.assets[aid] = {"group": group, "cell": cell,
                                "kwh": 0.0, "idle_kwh": 0.0, "kw": 0.0}
        for key in CELL_ORDER:
            for st in self.cells[key]["stations"]:
                _asset(st["robot_id"], "robot", CELL_IDS[key])
                if st["machine_id"]:
                    _asset(st["machine_id"], "cnc", CELL_IDS[key])
        for i in range(len(self.cells["welding"]["stations"])):
            _asset(f"WC-{i + 1:02d}", "welding_controller", CELL_IDS["welding"])
        for i in range(len(self.cells["vision_inspection"]["stations"])):
            _asset(f"VIS-{i + 1:02d}", "vision", CELL_IDS["vision_inspection"])
        for c in CONVEYORS:
            _asset(c, "conveyor", None)
        for a in self.amrs:
            _asset(a["amr_id"], "amr", None)
        _asset("CHARGER", "charger", None)
        _asset("AUX", "auxiliary", None)
        _asset("COMPRESSOR", "compressed_air", None)   # v7 §44.10 廠務能耗
        _asset("HVAC", "hvac", None)
        self.energy_policy: set[str] = set()       # §41.7（scenario 分支設定，不入 dump）
        self._rebuild_asset_refs()

        # ---- §40 Flow analytics（顯示層時間分析的權威來源） ----
        self.lead_samples: list[float] = []            # 最近 100 件 good 的 lead time（秒）
        self.cycle_samples: dict[str, list[float]] = {k: [] for k in CELL_ORDER}
        self.buf_full_sec: dict[str, float] = {k: 0.0 for k in self.inter}  # 連續滿載秒數
        self.flow_history: list[dict] = []             # 每分鐘 flow 快照（保留 480）
        self._min_cell0 = {k: 0 for k in CELL_ORDER}   # 每分鐘 cell 完工數基準
        self._min_busy0 = {k: 0.0 for k in CELL_ORDER}
        self._min_fleet0 = 0

        # ---- 計數器（守恆式的權威來源） ----
        self.created = 0
        self.good = 0
        self.shipped = 0                    # 已由 AMR 收集出貨的 good 子集
        self.scrap = 0
        self.first_pass_inspections = 0
        self.first_pass_fails = 0
        self.rework_events = 0
        self.energy_kwh = 0.0
        self.peak_kw = 0.0
        self.downtime_sec = 0.0
        self.alerts: list[dict] = []
        self._alerted: set[str] = set()
        self.recent_inspections: list[dict] = []   # 感知層（vision）觀測用的 ground truth

        # per-minute aggregator（§10.7；Live 與 Pre-roll 共用同一段程式）
        self.history: list[dict] = []
        self._min_good0 = 0
        self._min_fail0 = 0
        self._min_kwh0 = 0.0

    def _rebuild_asset_refs(self) -> None:
        """效能：預先解析每站對應的資產 dict 參照（load_state 後需重建）。"""
        self._st_assets = {}
        for key in CELL_ORDER:
            rows = []
            for i, st in enumerate(self.cells[key]["stations"]):
                rows.append((
                    self.assets[st["robot_id"]],
                    self.assets[st["machine_id"]] if st["machine_id"] else None,
                    self.assets[f"WC-{i + 1:02d}"] if key == "welding" else None,
                    self.assets[f"VIS-{i + 1:02d}"] if key == "vision_inspection" else None,
                ))
            self._st_assets[key] = rows
        self._conv_assets = [self.assets[c] for c in CONVEYORS]
        self._amr_assets = [self.assets[a["amr_id"]] for a in self.amrs]
        self._aux_asset = self.assets["AUX"]
        self._charger_asset = self.assets["CHARGER"]
        self._compressor_asset = self.assets["COMPRESSOR"]
        self._hvac_asset = self.assets["HVAC"]

    # ------------------------------------------------------------ helpers
    def _emit(self, source_type, source_id, event_type, severity, message,
              cell_id=None, value=None, threshold=None) -> dict:
        return self.bus.emit(sim_tick=self.clock.tick, sim_time=self.clock.sim_time_iso,
                             source_type=source_type, source_id=source_id,
                             event_type=event_type, severity=severity, message=message,
                             line_id="LINE-01", cell_id=cell_id, value=value, threshold=threshold)

    def _audit_transition(self, source, prev, new, reason, seq=None):
        self.audit.record(sim_time=self.clock.sim_time_iso, actor="engine", source=source,
                          action="STATE_CHANGED", previous_state=prev, new_state=new,
                          reason=reason, event_seq=seq)

    def _new_part(self) -> str:
        self.created += 1
        pid = f"PART-{self.created:05d}"
        self.parts[pid] = {"part_id": pid, "created_tick": self.clock.tick,
                           "lifecycle": "PROCESSING", "quality": "UNKNOWN",
                           "location_type": "STATION", "location_id": None,
                           "operation": "WELDING", "first_inspected": False}
        return pid

    def wip(self) -> int:
        return len(self.parts)

    def check_conservation(self) -> None:
        assert self.created == self.wip() + self.good + self.scrap, (
            f"conservation violated: created={self.created} wip={self.wip()} "
            f"good={self.good} scrap={self.scrap}")

    # ------------------------------------------------------------ tick
    def step(self) -> None:
        dt = self.clock.dt
        self._conveyors_advance(dt)
        for key in reversed(CELL_ORDER):      # 下游先處理，讓空間先釋放
            self._cell_process(key, dt)
        for key in reversed(CELL_ORDER):
            self._cell_dispatch(key)
        self._rework_tick(dt)
        # §50：AMR 空間模型每 tick（0.1 s）推進——位置以 10 Hz 增量串流上 wire，
        # 前端不再外插（WareTwin 借鏡）。其餘慢速子系統維持 0.5 s 決定性節奏。
        self._amr_tick(dt)
        if self.clock.tick % SLOW_DECIMATION == 0:
            self._bookkeeping_slow(dt * SLOW_DECIMATION)
        self._repair_faults()
        self.clock.advance()
        if self.clock.tick % 600 == 0:
            self._flush_minute()

    def run_ticks(self, n: int, conservation_every: int = 0) -> None:
        for i in range(n):
            self.step()
            if conservation_every and i % conservation_every == 0:
                self.check_conservation()

    # ------------------------------------------------------------ conveyors
    def _conveyors_advance(self, dt: float) -> None:
        for i, cid in enumerate(CONVEYORS):
            cs = self.conv_state[cid]
            if cs["status"] == "JAMMED":
                if self.clock.tick >= cs["jam_until"]:
                    cs["status"], cs["full_emitted"] = "RUNNING", False
                    self._emit("CONVEYOR", cid, "CONVEYOR_REPAIRED", "INFO",
                               f"{cid} jam cleared")
                    self._resolve_alert(cid)
                    self._audit_transition(cid, "JAMMED", "RUNNING", "jam cleared")
                else:
                    continue                       # 卡住：在途件不前進、不卸載
            items = self.conveyors[cid]
            for it in items:
                it["remaining"] = max(0.0, it["remaining"] - dt)
            dest = self.inter[self.inter_after[CELL_ORDER[i]]]
            cap = self.params["buffers"][self.inter_after[CELL_ORDER[i]]]["capacity"]
            while items and items[0]["remaining"] <= 0 and len(dest) < cap:
                it = items.pop(0)
                dest.append(it["part_id"])
                part = self.parts[it["part_id"]]
                part["lifecycle"] = "QUEUED"
                part["location_type"], part["location_id"] = "BUFFER", self.inter_after[CELL_ORDER[i]]

    # ------------------------------------------------------------ cells
    def _try_output(self, key: str, pid: str) -> bool:
        """把完成件送出 cell：inspection 直接判定；其餘進下游 conveyor。"""
        if key == "vision_inspection":
            return self._judge(pid)
        idx = CELL_ORDER.index(key)
        cid = CONVEYORS[idx]
        conv = self.conveyors[cid]
        cs = self.conv_state[cid]
        if cs["status"] == "JAMMED" or len(conv) >= self.conv_cfg[cid]["in_transit_max"]:
            if cs["status"] == "JAMMED" and not cs["full_emitted"]:
                cs["full_emitted"] = True
                buf_id = self.inter_after[key]
                self._emit("BUFFER", buf_id, "OUTPUT_BUFFER_FULL", "HIGH",
                           f"{key} output path full behind jammed {cid}",
                           cell_id=CELL_IDS[key])
            return False
        if True:
            conv.append({"part_id": pid, "remaining": float(self.conv_cfg[cid]["transit_sec"])})
            part = self.parts[pid]
            part["lifecycle"], part["location_type"], part["location_id"] = "IN_TRANSIT", "CONVEYOR", cid
            return True
        return False

    def _judge(self, pid: str) -> bool:
        part = self.parts[pid]
        first = not part["first_inspected"]
        if first:
            part["first_inspected"] = True
            self.first_pass_inspections += 1
        if "verdict" not in part:      # 判定只抽一次；BLOCKED 重試不得重抽
            u = self.rng.stream("process").random()
            p_fail = self.params["cells"]["vision_inspection"]["fail_probability"]
            part["verdict"] = u < p_fail
            if part["verdict"]:            # defect type 由同一個 u 決定（零額外抽樣）
                third = u / p_fail
                part["defect_type"] = ("scratch" if third < 1 / 3 else
                                       "missing_component" if third < 2 / 3 else
                                       "misalignment")
        fail = part["verdict"]
        if fail:
            if first:
                self.first_pass_fails += 1
            cap = self.params["buffers"]["rework_area"]["capacity"]
            if len(self.rework) >= cap:
                return False                      # rework 滿 → station BLOCKED（不得刪件）
            self.rework_events += 1
            part["quality"] = "REWORK_REQUIRED"
            part["lifecycle"], part["location_type"], part["location_id"] = \
                "QUEUED", "REWORK_AREA", "rework_area"
            self.rework.append({"part_id": pid,
                                "remaining": float(self.params["buffers"]["rework_area"]["rework_time_sec"])})
            self._record_inspection(pid, part.get("defect_type", "scratch"), first)
            seq = self._emit("CAMERA", "CAM-01", "INSPECTION_FAIL", "MEDIUM",
                             f"{pid} failed inspection → rework",
                             cell_id=CELL_IDS["vision_inspection"])["seq"]
            self._audit_transition(pid, "UNKNOWN", "REWORK_REQUIRED", "inspection fail", seq)
        else:
            part["quality"], part["lifecycle"] = "PASS", "COMPLETED"
            part["location_type"], part["location_id"] = "FINISHED", "finished_goods"
            self._record_inspection(pid, "ok", first)
            lead = (self.clock.tick - part.get("created_tick", self.clock.tick)) * self.clock.dt
            self.lead_samples.append(round(lead, 1))
            if len(self.lead_samples) > 100:
                self.lead_samples = self.lead_samples[-100:]
            del self.parts[pid]
            self.good += 1
            self._emit("CAMERA", "CAM-01", "INSPECTION_PASS", "INFO",
                       f"{pid} passed inspection", cell_id=CELL_IDS["vision_inspection"])
        return True

    def _record_inspection(self, pid: str, ground_truth: str, first_pass: bool) -> None:
        self.recent_inspections.append({
            "part_id": pid, "ground_truth": ground_truth, "first_pass": first_pass,
            "sim_time": self.clock.sim_time_iso, "sim_tick": self.clock.tick})
        if len(self.recent_inspections) > 50:
            self.recent_inspections = self.recent_inspections[-50:]

    def _cell_process(self, key: str, dt: float) -> None:
        cell = self.cells[key]
        for st in cell["stations"]:
            if st["fault_kind"] is not None:
                continue                            # 故障中：不推進、不完工
            if st["part_id"] is None:
                continue
            st["elapsed"] += dt
            st["busy_time"] += dt
            if st["elapsed"] + 1e-9 >= cell["cycle"]:
                if self._try_output(key, st["part_id"]):
                    if st["state"] == "BLOCKED":
                        self._transition(st, key, "PROCESSING", "downstream space available")
                    self._emit("STATION", st["station_id"], "CYCLE_COMPLETED", "INFO",
                               f"{st['part_id']} {OPERATION[key].lower()} completed",
                               cell_id=CELL_IDS[key])
                    st["completions"] += 1
                    cs_l = self.cycle_samples[key]
                    cs_l.append(round(st["elapsed"], 1))
                    if len(cs_l) > 200:
                        del cs_l[: len(cs_l) - 200]
                    st["part_id"] = None
                    st["elapsed"] = 0.0
                    st["state"] = "READY"
                    st["idle_since"] = self.clock.tick
                    self._maybe_minor_stop(key, st)
                else:
                    if st["state"] != "BLOCKED":
                        self._transition(st, key, "BLOCKED", "output full")
                    st["blocked_time"] += dt
                    st["busy_time"] -= dt        # blocked 不算 busy

    def _transition(self, st: dict, key: str, new: str, reason: str) -> None:
        prev = st["state"]
        st["state"] = new
        sev = "HIGH" if new == "BLOCKED" else ("MEDIUM" if new == "STARVED" else "INFO")
        ev = self._emit("STATION", st["station_id"],
                        f"STATION_{new}" if new in ("BLOCKED", "STARVED") else "STATION_STATE",
                        sev, f"{st['station_id']} {prev} → {new} ({reason})", cell_id=CELL_IDS[key])
        self._audit_transition(st["station_id"], prev, new, reason, ev["seq"])

    def _cell_dispatch(self, key: str) -> None:
        cell = self.cells[key]
        while True:
            ready = [s for s in cell["stations"]
                     if s["part_id"] is None and s["fault_kind"] is None]
            if not ready:
                return
            pid = None
            if self.racks[key]["qty"] <= 0:
                break                                  # §39.3 無耗材不得開始 Cycle
            if key == "welding":
                if self.raw_stock <= 0:
                    break
            else:
                prev_key = CELL_ORDER[CELL_ORDER.index(key) - 1]
                buf = self.inter[self.inter_after[prev_key]]
                if not buf:
                    break
            # dispatcher（§10.5）：READY → 最長 idle → robot health 高 → station id 升冪
            ready.sort(key=lambda s: (s["idle_since"], -self._tool_health(s), s["station_id"]))
            st = ready[0]
            if key == "welding":
                self.raw_stock -= 1
                pid = self._new_part()
            else:
                pid = buf.pop(0)
            self.racks[key]["qty"] -= 1                # §39 每 cycle start 消耗 1 耗材
            part = self.parts[pid]
            part["lifecycle"], part["operation"] = "PROCESSING", OPERATION[key]
            part["location_type"], part["location_id"] = "STATION", st["station_id"]
            if st["state"] == "STARVED":
                self._transition(st, key, "PROCESSING", "part available")
            else:
                st["state"] = "PROCESSING"
            st["part_id"] = pid
            st["elapsed"] = 0.0

    # ------------------------------------------------------------ rework / AMR
    def _rework_tick(self, dt: float) -> None:
        for it in self.rework:
            it["remaining"] = max(0.0, it["remaining"] - dt)
        buf = self.inter["machining_to_inspection"]
        cap = self.params["buffers"]["machining_to_inspection"]["capacity"]
        while self.rework and self.rework[0]["remaining"] <= 0 and len(buf) < cap:
            it = self.rework.pop(0)
            part = self.parts[it["part_id"]]
            part["quality"], part["lifecycle"] = "UNKNOWN", "QUEUED"
            part.pop("verdict", None)      # 重工後重新判定
            part["location_type"], part["location_id"] = "BUFFER", "machining_to_inspection"
            buf.append(it["part_id"])
            self._emit("STATION", "REWORK", "REWORK_COMPLETED", "INFO",
                       f"{it['part_id']} rework done, re-queued for inspection",
                       cell_id=CELL_IDS["vision_inspection"])

    # -------------------------------------------------- §39 Intralogistics fleet
    def _phase_len(self, phase: str) -> float:
        fl = self.params["intralogistics"]["fleet"]
        return float({"TRAVEL_TO_PICKUP": fl["travel_to_pickup_sec"],
                      "DOCKING_PICKUP": fl["docking_sec"],
                      "LOADING": fl["loading_sec"],
                      "TRAVEL_TO_DROPOFF": fl["travel_to_dropoff_sec"],
                      "DOCKING_DROPOFF": fl["docking_sec"],
                      "UNLOADING": fl["unloading_sec"],
                      "RETURNING": fl["return_sec"]}[phase])

    # -------------------------------------------------- §47 空間模型與交通
    def _traffic(self) -> dict:
        return self.params["intralogistics"]["traffic"]

    def _lane_z(self, a: dict, alt: bool) -> float:
        """各 AMR 專屬走廊車道（雙向對開不同線）；alt = 備援走廊（改道）。"""
        tr = self._traffic()
        off = tr["lane_offset_m"] if a["amr_id"] == "AMR-02" else -tr["lane_offset_m"]
        return AMR_CORRIDOR_Z + (tr["alt_corridor_dz"] if alt else 0.0) + off

    @staticmethod
    def _seg_lens(pts: list[list[float]]) -> list[float]:
        return [((pts[i + 1][0] - pts[i][0]) ** 2
                 + (pts[i + 1][1] - pts[i][1]) ** 2) ** 0.5
                for i in range(len(pts) - 1)]

    def _travel_goals(self, a: dict) -> list[tuple[float, float]]:
        t, ts = a["task"], a["task_state"]
        if ts == "TRAVEL_TO_PICKUP":
            key = ("finished_goods" if t["type"] == "FG_COLLECT"
                   else "receiving" if t["type"] == "INBOUND_RESTOCK"
                   else "supermarket")
            return [AMR_DOCKS[key]]
        if ts == "TRAVEL_TO_DROPOFF":
            key = ("staging" if t["type"] == "FG_COLLECT"
                   else "raw_material" if t["type"] == "RAW_REPLENISH"
                   else t["target"])
            return [AMR_DOCKS.get(key, AMR_DOCKS["raw_material"])]
        # RETURNING：空箱先繞 Supermarket 空箱架，再回充電位（§47.2）
        home = AMR_HOME[a["amr_id"]]
        if a["carrying"] == "empty":
            return [AMR_DOCKS["supermarket"], home]
        return [home]

    def _col_off(self, a: dict) -> float:
        """縱向（column）專屬車道偏移：兩台 AMR 進出 dock 的垂直支線永不共線，
        頭對頭僵持在幾何上不可能發生（§47.3）。"""
        tr = self._traffic()
        return tr["column_offset_m"] if a["amr_id"] == "AMR-02" \
            else -tr["column_offset_m"]

    def _immobile_others(self, a: dict) -> list[dict]:
        """目前不可動的他車（故障／障礙／停靠作業／閒置停放）——路線規劃避開。"""
        out = []
        for o in self.amrs:
            if o is a:
                continue
            if o["task_state"] == "ERROR" \
                    or o.get("obstacle_until", 0) > self.clock.tick \
                    or o["task_state"] in ("DOCKING_PICKUP", "LOADING",
                                           "DOCKING_DROPOFF", "UNLOADING",
                                           "IDLE", "CHARGING"):
                out.append(o)
        return out

    @staticmethod
    def _seg_point_dist(p: list[float], q: list[float], c: list[float]) -> float:
        vx, vz = q[0] - p[0], q[1] - p[1]
        wx, wz = c[0] - p[0], c[1] - p[1]
        l2 = vx * vx + vz * vz
        t = 0.0 if l2 == 0 else max(0.0, min(1.0, (wx * vx + wz * vz) / l2))
        dx, dz = wx - t * vx, wz - t * vz
        return (dx * dx + dz * dz) ** 0.5

    def _enter_travel(self, a: dict, alt: bool = False) -> bool:
        """路線規劃（§47.3）：一律從當前實際位置出發（根除位置跳變）。
        候選 = {主/備援走廊} × {左右縱向支線} × {三個上升點偏移}（12 條），
        每條 = 側移出停靠點 → 縱向支線 → 走廊車道 → 目標縱向支線 → dock 正位；
        成本 = 長度 ＋ 不可動車輛淨空罰分 → 取最小（決定性）。
        相位時長 = 路線長 / 速度。alt=True 時優先嘗試備援走廊（改道語意）。
        回傳值（§53）：選中的路線是否**不穿越任何空間障礙物淨空**。
        全部候選都穿越 → 回傳 False、`a["path_blocked"]=True`，不宣稱 DETOUR；
        呼叫端據此進入 NO_SAFE_PATH 等待（單一事件、退避重試），不再每 tick 重規劃。"""
        tr = self._traffic()
        speed = self.params["intralogistics"]["fleet"]["speed_m_per_s"]
        goals = self._travel_goals(a)
        # 避讓點：(位置, 淨空) —— 不可動車輛 ＋ §48 空間障礙物（半徑 + hard_stop）
        avoid: list[tuple[list[float], float]] = \
            [(o["pos"], tr["hard_stop_m"] + 0.35) for o in self._immobile_others(a)] \
            + [([ob["x"], ob["z"]], ob["radius"] + tr["hard_stop_m"])
               for ob in self.obstacles]
        lane_off = tr["lane_offset_m"] if a["amr_id"] == "AMR-02" \
            else -tr["lane_offset_m"]
        base_co = self._col_off(a)
        x0, z0 = round(a["pos"][0], 2), round(a["pos"][1], 2)
        corridors = [("alt", AMR_CORRIDOR_Z + tr["alt_corridor_dz"]),
                     ("main", AMR_CORRIDOR_Z)] if alt else \
                    [("main", AMR_CORRIDOR_Z),
                     ("alt", AMR_CORRIDOR_Z + tr["alt_corridor_dz"])]
        candidates: list[tuple[list[list[float]], str, float]] = []   # (pts, kind, len)
        for kind, zbase in corridors:
            z = zbase + lane_off
            for co in (base_co, -base_co):
                for dxa in (0.0, -2.4, 2.4):
                    pts: list[list[float]] = [[x0, z0]]

                    def _push(x: float, zz: float) -> None:
                        if abs(x - pts[-1][0]) + abs(zz - pts[-1][1]) > 0.05:
                            pts.append([round(x, 2), round(zz, 2)])
                    first = True
                    for g in goals:
                        px, pz = pts[-1]
                        if abs(pz - z) > 0.3:
                            xa = px + co + (dxa if first else 0.0)
                            xa = min(EVADE["x_max"], max(EVADE["x_min"], xa))
                            _push(xa, pz)       # 側移出 dock 正位
                            _push(xa, z)        # 縱向支線進走廊
                        _push(g[0] + co, z)     # 走廊車道
                        _push(g[0] + co, g[1])  # 目標縱向支線
                        _push(g[0], g[1])       # 側移進 dock 正位
                        first = False
                    candidates.append((pts, kind, sum(self._seg_lens(pts))))

        def _pick(av: list[tuple[list[float], float]]):
            bst = None
            for pts_, kind_, length_ in candidates:
                pen = 0.0
                for i in range(len(pts_) - 1):
                    for c, clearance in av:
                        d = self._seg_point_dist(pts_[i], pts_[i + 1], c)
                        if d < clearance:
                            pen += 1000.0 + (clearance - d) * 200.0
                cost = length_ + pen
                if bst is None or cost < bst[0] - 1e-6:   # 平手 → 保留先出現者（偏好序）
                    bst = (cost, pts_, kind_, length_)
            return bst
        best = _pick(avoid)
        assert best is not None
        # §53：選中的路線是否仍穿越障礙物淨空（規劃器「盡力」但沒有安全路徑）
        ob_av = avoid[len(avoid) - len(self.obstacles):]
        blocked = any(self._seg_point_dist(best[1][i], best[1][i + 1], c) < cl - 1e-6
                      for i in range(len(best[1]) - 1) for c, cl in ob_av)
        was_blocked = a.get("path_blocked", False)
        a["path_blocked"] = blocked
        # §48 可觀測性：若因空間障礙物而選了不同於無障礙時的路線 → AMR_DETOUR
        # （§53：真的繞開才算 DETOUR；無安全路徑時不宣稱）
        if self.obstacles and not blocked and not was_blocked:
            free = _pick([(c, cl) for c, cl in avoid[:len(avoid) - len(self.obstacles)]])
            if free is not None and free[1] != best[1]:
                self._emit("AMR", a["amr_id"], "AMR_DETOUR", "INFO",
                           f"{a['amr_id']} planned around "
                           f"{'/'.join(ob['obstacle_id'] for ob in self.obstacles)} "
                           f"(+{max(0.0, best[3] - free[3]):.1f} m)")
        route = best[1]
        a["route"] = route
        a["route_kind"] = best[2]
        a["phase_total"] = a["phase_remaining"] = \
            max(0.2, sum(self._seg_lens(route)) / speed)   # 無「最短 2 s」地板：短路線不得超速（§50）
        # 空箱回程：行經 Supermarket 即卸空箱（drop_f = 該點在**選中**路線上的比例；
        # 先前誤用迴圈殘留的最後一條候選）
        a["drop_f"] = 0.0
        if a["task_state"] == "RETURNING" and a["carrying"] == "empty" and len(goals) == 2:
            lens = self._seg_lens(route)
            total = sum(lens) or 1.0
            acc, drop = 0.0, 0.0
            sm = AMR_DOCKS["supermarket"]
            for i, seg in enumerate(lens):
                acc += seg
                if abs(route[i + 1][0] - sm[0]) < 0.1 and abs(route[i + 1][1] - sm[1]) < 0.1:
                    drop = acc / total
                    break
            a["drop_f"] = drop
        return not blocked

    def _blocked_step(self, a: dict, dt: float) -> bool:
        """§53 NO_SAFE_PATH：目前沒有任何不穿越障礙淨空的候選路線。
        停在原地（status WAITING、traffic BLOCKED）、只發一次 AMR_PATH_BLOCKED，
        每 reroute_after_sec 秒重規劃一次；障礙移除／路徑恢復 → AMR_PATH_CLEAR 並續行。
        回傳 True = 本 tick 已處理（呼叫端 continue）。"""
        if not a.get("path_blocked"):
            return False
        tr = self._traffic()
        a["status"] = "WAITING"
        a["kpi"]["yield_sec"] += dt
        a["blocked_since"] = a.get("blocked_since", 0.0) + dt
        if not a.get("blocked_event"):
            a["blocked_event"] = True
            self._emit("AMR", a["amr_id"], "AMR_PATH_BLOCKED", "MEDIUM",
                       f"{a['amr_id']} has no safe path to "
                       f"{a['task_state'].replace('TRAVEL_TO_', '').lower()} — every candidate "
                       f"route crosses {'/'.join(ob['obstacle_id'] for ob in self.obstacles) or 'an obstacle'}; "
                       f"holding and retrying every {tr['reroute_after_sec']:.0f} s")
        if a["blocked_since"] >= tr["reroute_after_sec"]:
            a["blocked_since"] = 0.0
            if self._enter_travel(a, alt=(a["route_kind"] == "main")):
                a["blocked_event"] = False
                self._after_reroute(a)
                self._emit("AMR", a["amr_id"], "AMR_PATH_CLEAR", "INFO",
                           f"{a['amr_id']} safe path available again, resuming")
                return False
        return True

    @staticmethod
    def _moving_status(a: dict) -> str:
        return "RETURNING" if a["task_state"] == "RETURNING" else "DELIVERING"

    def _after_reroute(self, a: dict) -> None:
        """改道後的一致狀態：讓行記帳歸零、status 回到行進。"""
        a["yielding"], a["yield_since"], a["yield_event"] = False, 0.0, False
        a["status"] = "WAITING" if a.get("path_blocked") else self._moving_status(a)   # §53

    def _route_lens(self, a: dict) -> list[float]:
        """路線分段長度（快取於 AMR dict；§50 每 tick 推進的效能）。"""
        pts = a["route"]
        lens = a.get("route_lens")
        # 快取以「路線物件身分」為鍵：同點數但不同幾何的新路線也會重算（dump/load 後身分變 → 重算）
        if lens is None or a.get("_route_lens_ref") is not pts or len(lens) != len(pts) - 1:
            lens = self._seg_lens(pts)
            a["route_lens"] = lens
            a["_route_lens_ref"] = pts
        return lens

    def _route_seg(self, a: dict, f: float) -> tuple[int, float]:
        """f → (分段索引, 段內比例)。"""
        lens = self._route_lens(a)
        total = sum(lens) or 1.0
        d = max(0.0, min(1.0, f)) * total
        for i, seg in enumerate(lens):
            if d <= seg:
                return i, (d / seg if seg else 1.0)
            d -= seg
        return len(lens) - 1, 1.0

    def _route_point(self, a: dict, f: float) -> list[float]:
        pts = a["route"]
        if len(pts) < 2:
            return list(a["pos"])
        i, k = self._route_seg(a, f)
        return [round(pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, 2),
                round(pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k, 2)]

    def _heading(self, a: dict) -> tuple[float, float]:
        """行進方向單位向量（目前所在分段的方向；段末則取下一段）。"""
        pts = a["route"]
        if len(pts) < 2:
            return (0.0, 0.0)
        f = 1.0 - (a["phase_remaining"] / a["phase_total"] if a["phase_total"] else 0.0)
        i, k = self._route_seg(a, f)
        if k >= 0.999 and i + 2 < len(pts):
            i += 1
        dx, dz = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
        n = (dx * dx + dz * dz) ** 0.5
        return (dx / n, dz / n) if n > 1e-6 else (0.0, 0.0)

    @staticmethod
    def _rank(a: dict) -> tuple[int, str]:
        """路權排序（小者優先）：任務 priority → amr_id（決定性）。"""
        pr = a["task"]["priority"] if a["task"] else 9
        return (pr, a["amr_id"])

    def _traffic_decision(self, a: dict) -> tuple[str, dict | None]:
        """前方近距他車偵測 → ('go'|'yield'|'reroute_now', blocker)。
        規則（決定性）：路權高者（任務 priority 小→amr_id 小）不停車續行
        （貼身 hard_stop 保險除外）；低路權者遇對頭立即改道、其餘停等；
        對硬靜止者（停靠/故障/障礙/讓行中）一律停等。
        遲滯：已在讓行者以 clear_distance 判斷解除，避免抖動。"""
        tr = self._traffic()
        thresh = tr["clear_distance_m"] if a["yielding"] else tr["safe_distance_m"]
        hx, hz = self._heading(a)
        for o in self.amrs:
            if o is a:
                continue
            dx, dz = o["pos"][0] - a["pos"][0], o["pos"][1] - a["pos"][1]
            d = (dx * dx + dz * dz) ** 0.5
            if d >= thresh:
                continue
            if d > 1e-6 and (hx * dx + hz * dz) / d < 0.1:
                continue                               # 對方在側後方 → 不擋路
            o_moving = (o["task_state"].startswith("TRAVEL")
                        or o["task_state"] == "RETURNING") \
                and not o["yielding"] \
                and o.get("obstacle_until", 0) <= self.clock.tick \
                and o["status"] != "ERROR"
            if o_moving:
                ox, oz = self._heading(o)
                if d > 1e-6 and (ox * dx + oz * dz) / d > 0.3:
                    continue                           # 前車同向遠離 → 不擋路
                if self._rank(a) < self._rank(o):
                    if d >= tr["hard_stop_m"]:
                        continue                       # 我有路權 → 續行
                    return ("yield", o)                # 貼身保險：絕不重疊
                if hx * ox + hz * oz < -0.5:
                    return ("reroute_now", o)          # 對頭 → 低路權者立即改道
                return ("yield", o)
            # 對方「讓行中」且我路權較高 → 通過（破解互讓死鎖；貼身保險仍生效）
            if o["yielding"] and self._rank(a) < self._rank(o) \
                    and d >= tr["hard_stop_m"]:
                continue
            # §50：硬靜止者不在我剩餘路線的淨空內（如停在鄰側支線）→ 不必讓行；
            # 鉗制保證不重疊。否則故障車停在 dock 附近會讓來車永遠排隊（takeover 斷料）
            if self._route_clearance(a, o["pos"]) >= tr["hard_stop_m"] + 0.1:
                continue
            return ("yield", o)                        # 硬靜止 → 停等（逾時改道）
        # §48 空間障礙物在前方且目前路線穿越其淨空 → 立即重規劃（規劃器會繞開）
        for ob in self.obstacles:
            dx, dz = ob["x"] - a["pos"][0], ob["z"] - a["pos"][1]
            d = (dx * dx + dz * dz) ** 0.5
            if d < ob["radius"] + thresh and d > 1e-6 and (hx * dx + hz * dz) / d > 0.1 \
                    and self._route_hits_obstacle(a, ob):
                return ("reroute_now", None)
        return ("go", None)

    def _traffic_step(self, a: dict, dt: float) -> bool:
        """交通判斷與讓行記帳。回傳是否可前進（含改道後續行）。"""
        act, blocker = self._traffic_decision(a)
        if act == "go":
            return True     # 讓行狀態由實際移動成功與否重置（_move_clamped）
        tr = self._traffic()
        if act == "reroute_now" and not self._goal_blocked(a, blocker):
            ok = self._enter_travel(a, alt=(a["route_kind"] == "main"))
            self._after_reroute(a)
            if not ok:                      # §53：沒有安全路徑 → 交給 _blocked_step，不宣稱改道
                return False
            self._emit("AMR", a["amr_id"], "AMR_REROUTED", "INFO",
                       f"{a['amr_id']} head-on with {blocker['amr_id']}, "
                       f"taking bypass corridor" if blocker is not None else
                       f"{a['amr_id']} obstacle ahead, replanning around it")
            return True
        a["yielding"] = True
        a["yield_since"] += dt
        a["status"] = "WAITING"
        a["kpi"]["yield_sec"] += dt
        if not a["yield_event"]:
            a["yield_event"] = True
            self._emit("AMR", a["amr_id"], "AMR_YIELD", "INFO",
                       f"{a['amr_id']} yielding to "
                       f"{blocker['amr_id'] if blocker else 'traffic'} ahead")
        # 近距讓行 → 反向避讓一步（讓出路口），之後從新位置重新規劃（§47.4）
        if blocker is not None:
            d = ((blocker["pos"][0] - a["pos"][0]) ** 2
                 + (blocker["pos"][1] - a["pos"][1]) ** 2) ** 0.5
            if 1e-6 < d < tr["backoff_m"]:
                sp = self.params["intralogistics"]["fleet"]["speed_m_per_s"]
                ux = (a["pos"][0] - blocker["pos"][0]) / d
                uz = (a["pos"][1] - blocker["pos"][1]) / d
                cand = [round(min(EVADE["x_max"], max(EVADE["x_min"], a["pos"][0] + ux * sp * dt)), 2),
                        round(min(EVADE["z_max"], max(EVADE["z_min"], a["pos"][1] + uz * sp * dt)), 2)]
                if all(o is a or ((o["pos"][0] - cand[0]) ** 2
                                  + (o["pos"][1] - cand[1]) ** 2) ** 0.5
                       >= tr["hard_stop_m"] for o in self.amrs):
                    a["pos"] = cand
                    self._enter_travel(a, alt=(a["route_kind"] == "alt"))
                return False
        hold = tr["reroute_after_sec"] \
            + (tr["right_of_way_hold_sec"]
               if blocker is not None and self._rank(a) < self._rank(blocker) else 0)
        if a["yield_since"] >= hold and not self._goal_blocked(a, blocker):
            ok = self._enter_travel(a, alt=(a["route_kind"] == "main"))
            self._after_reroute(a)
            if not ok:
                return False
            self._emit("AMR", a["amr_id"], "AMR_REROUTED", "INFO",
                       f"{a['amr_id']} rerouted via "
                       f"{'bypass' if a['route_kind'] == 'alt' else 'main'} "
                       f"corridor (lane blocked {hold:.0f}s)")
            return True
        return False

    def _move_clamped(self, a: dict, dt: float) -> None:
        """相位前進＋位置更新，含空間鉗制：候選點距任一他車 < hard_stop 則
        本 tick 凍結（相位不前進）——中心距下限的絕對保證（§47.4）。
        凍結亦累計讓行逾時 → 改道重規劃，保證前進性。"""
        tr = self._traffic()
        rem = max(0.0, a["phase_remaining"] - dt)
        f = 1.0 - (rem / a["phase_total"] if a["phase_total"] else 0.0)
        cand = self._route_point(a, f)
        # 鉗制對象：他車（hard_stop）＋ §48 空間障礙物（半徑 + 0.5）
        near = [(o["pos"], tr["hard_stop_m"]) for o in self.amrs if o is not a] \
            + [([ob["x"], ob["z"]], ob["radius"] + 0.5) for ob in self.obstacles]
        for c, lim in near:
            if ((c[0] - cand[0]) ** 2 + (c[1] - cand[1]) ** 2) ** 0.5 < lim:
                a["status"] = "WAITING"
                a["yielding"] = True
                a["yield_since"] += dt
                a["kpi"]["yield_sec"] += dt
                if a["yield_since"] >= tr["reroute_after_sec"] * 2:
                    ok = self._enter_travel(a, alt=(a["route_kind"] == "main"))
                    self._after_reroute(a)
                    if ok:
                        self._emit("AMR", a["amr_id"], "AMR_REROUTED", "INFO",
                                   f"{a['amr_id']} replanning around traffic")
                return
        a["phase_remaining"] = rem
        mx, mz = cand[0] - a["pos"][0], cand[1] - a["pos"][1]
        mn = (mx * mx + mz * mz) ** 0.5
        if mn > 1e-6:
            a["last_heading"] = [round(mx / mn, 3), round(mz / mn, 3)]   # §51 感知用（停下也保留朝向）
        a["pos"] = cand
        if a["yielding"]:       # 實際動起來了 → 讓行解除
            a["yielding"], a["yield_since"], a["yield_event"] = False, 0.0, False
            a["status"] = "RETURNING" if a["task_state"] == "RETURNING" \
                else "DELIVERING"
            self._emit("AMR", a["amr_id"], "AMR_RESUMED", "INFO",
                       f"{a['amr_id']} lane clear, resuming")

    def _remaining_route(self, a: dict) -> list[list[float]]:
        """從目前進度點起的剩餘路線折線（已走過的路段不計）。"""
        pts = a["route"]
        if len(pts) < 2:
            return []
        f = 1.0 - (a["phase_remaining"] / a["phase_total"] if a["phase_total"] else 0.0)
        lens = self._seg_lens(pts)
        d = max(0.0, min(1.0, f)) * (sum(lens) or 1.0)
        for i, seg in enumerate(lens):
            if d <= seg:
                k = d / seg if seg else 1.0
                cur = [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k,
                       pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k]
                return [cur] + [list(p) for p in pts[i + 1:]]
            d -= seg
        return [list(pts[-1])]

    def _route_hits_obstacle(self, a: dict, ob: dict) -> bool:
        """目前路線的**剩餘段**是否穿越障礙物淨空。"""
        pts = self._remaining_route(a)
        if len(pts) < 2:
            return False
        lim = ob["radius"] + self._traffic()["hard_stop_m"] - 0.05   # 規劃淨空的容差
        return any(self._seg_point_dist(pts[i], pts[i + 1], [ob["x"], ob["z"]]) < lim
                   for i in range(len(pts) - 1))

    def _route_clearance(self, a: dict, c: list[float]) -> float:
        """剩餘路線（自目前位置起）到點 c 的最小距離。"""
        pts = self._remaining_route(a)
        if len(pts) < 2:
            return ((a["pos"][0] - c[0]) ** 2 + (a["pos"][1] - c[1]) ** 2) ** 0.5
        return min(self._seg_point_dist(pts[i], pts[i + 1], c) for i in range(len(pts) - 1))

    def _goal_blocked(self, a: dict, o: dict | None) -> bool:
        """擋路者就停在我的路線終點（排隊情境）→ 等待而非改道。
        故障車不是排隊者（永遠不會離開）→ 不視為終點排隊（§50）。"""
        if o is None or o["task_state"] == "ERROR":
            return False
        end = a["route"][-1] if a["route"] else a["pos"]
        return ((o["pos"][0] - end[0]) ** 2 + (o["pos"][1] - end[1]) ** 2) ** 0.5 < 3.0

    def _order_task(self, ttype: str, target: str, batch: int) -> dict:
        self._task_no += 1
        task = {"task_id": f"T-{self._task_no:04d}", "type": ttype, "target": target,
                "batch": batch, "priority": TASK_PRIORITY[ttype],
                "created_tick": self.clock.tick, "assigned_tick": None}
        self.amr_queue.append(task)
        self._emit("SIMULATION", "fleet", "REPLENISHMENT_REQUESTED" if ttype != "FG_COLLECT"
                   else "COLLECT_ORDERED", "INFO" if ttype == "FG_COLLECT" else "LOW",
                   f"{task['task_id']} {ttype} → {target} (batch {batch}) queued")
        return task

    def _pending(self, ttype: str, target: str | None = None) -> bool:
        def match(t):
            return t and t["type"] == ttype and (target is None or t["target"] == target)
        return any(match(t) for t in self.amr_queue) or \
            any(match(a["task"]) for a in self.amrs)

    # ---- §51 感知層（讓行邏輯的可視化資料；純推導、不影響決策） -------------------
    def perception(self, a: dict) -> dict:
        """每台 AMR 的感知結構：感測範圍 sense_m 內的他車／障礙物（距離、相對方位），
        前方錐（±45°）最近距離 ahead_m，以及 state：STOPPED（讓行中）／CAUTION
        （前方 < clear_distance）／CLEAR。
        distance_m 的語意（明確標示於 ref 欄位）＝**交通邏輯實際拿來與
        safe／clear／hard_stop 比較的那個量**：他車為中心距（ref="center"；§47 門檻已含車身
        尺寸），空間障礙物為到邊緣距離（ref="edge"，附 radius_m）。兩者不混用同一把尺，
        但都與引擎判斷一致，前端配色與射線終點依 ref 畫。"""
        tr = self._traffic()
        sense = tr.get("sense_m", 6.0)
        hx, hz = self._heading(a) if len(a["route"]) >= 2 else (0.0, 0.0)
        if hx == 0.0 and hz == 0.0:
            hx, hz = a.get("last_heading", [1.0, 0.0])
        objs = []
        for o in self.amrs:
            if o is a:
                continue
            objs.append(("amr", o["amr_id"], o["pos"][0], o["pos"][1], 0.0, "center"))
        for ob in self.obstacles:
            objs.append(("obstacle", ob["obstacle_id"], ob["x"], ob["z"], ob["radius"], "edge"))
        seen, ahead = [], None
        for kind, oid, x, z, r, ref in objs:
            dx, dz = x - a["pos"][0], z - a["pos"][1]
            d = (dx * dx + dz * dz) ** 0.5
            edge = max(0.0, d - r)              # ref="center" 時 r=0 → 即中心距
            if edge > sense:
                continue
            # 方位：0° = 正前方，正 = 左（逆時針，俯視 x 右／z 下）
            cosb = (hx * dx + hz * dz) / d if d > 1e-6 else 1.0
            sinb = (hx * dz - hz * dx) / d if d > 1e-6 else 0.0
            bearing = math.degrees(math.atan2(sinb, cosb))
            seen.append({"kind": kind, "id": oid, "distance_m": round(edge, 1),
                         "bearing_deg": round(bearing, 0), "ref": ref, "radius_m": round(r, 2)})
            if abs(bearing) <= 45.0 and (ahead is None or edge < ahead):
                ahead = edge
        seen.sort(key=lambda o: (o["distance_m"], o["id"]))
        nearest = seen[0]["distance_m"] if seen else None
        state = ("STOPPED" if a.get("yielding") or a["status"] == "WAITING"
                 else "CAUTION" if ahead is not None and ahead < tr["clear_distance_m"]
                 else "CLEAR")
        return {"state": state, "heading": [round(hx, 3), round(hz, 3)],
                "ahead_m": None if ahead is None else round(ahead, 1),
                "nearest_m": nearest, "safe_m": tr["safe_distance_m"],
                "clear_m": tr["clear_distance_m"], "hard_stop_m": tr["hard_stop_m"],
                "sense_m": sense, "obstacles": seen}

    # ---- §51 派工 Decision Record ----------------------------------------------
    def _pickup_dock(self, task: dict) -> tuple[float, float]:
        key = ("finished_goods" if task["type"] == "FG_COLLECT"
               else "receiving" if task["type"] == "INBOUND_RESTOCK" else "supermarket")
        return AMR_DOCKS[key]

    def _dispatch_candidates(self, task: dict, floor: float) -> list[dict]:
        """每台 AMR 的派工評估（決定性）：適格與否、落選原因、到取貨點距離
        （走廊為 L 形路徑 → 曼哈頓距離）、偏好類別是否相符；適格者依
        偏好相符 → 距離 → amr_id 排名（rank 1 = 選中）。"""
        px, pz = self._pickup_dock(task)
        out = []
        for a in self.amrs:
            dist = abs(a["pos"][0] - px) + abs(a["pos"][1] - pz)
            pref = a["pref_priority"] == task["priority"]
            reason = None
            if a["task"] is not None:
                reason = f"busy with {a['task']['task_id']} ({a['task_state']})"
            elif a["task_state"] == "ERROR":
                reason = "faulted — under repair"
            elif a.get("obstacle_until", 0) > self.clock.tick:
                reason = "held as obstacle"
            elif a["task_state"] == "RETURNING":
                reason = "returning to charging bay"
            elif a["battery"] <= floor:
                reason = f"battery {a['battery']:.0f}% ≤ dispatch floor {floor:.0f}%"
            out.append({"amr_id": a["amr_id"], "eligible": reason is None,
                        "state": a["task_state"], "battery_percent": round(a["battery"], 1),
                        "distance_m": round(dist, 1), "pref_match": pref,
                        "rank": None, "rejected_reason": reason, "_amr": a})
        elig = sorted((c for c in out if c["eligible"]),
                      key=lambda c: (not c["pref_match"], c["distance_m"], c["amr_id"]))
        for i, c in enumerate(elig):
            c["rank"] = i + 1
        for c in out:
            if c["eligible"] and c["rank"] != 1:
                w = elig[0]
                c["rejected_reason"] = (
                    f"outranked by {w['amr_id']}: "
                    + ("preferred class" if w["pref_match"] and not c["pref_match"]
                       else f"nearer to pickup ({w['distance_m']:.1f} m vs {c['distance_m']:.1f} m)"
                       if w["distance_m"] < c["distance_m"] else "tie broken by amr_id"))
        return out

    def _record_decision(self, task: dict, cands: list[dict], chosen: dict | None) -> dict:
        self._decision_no += 1
        rows = [{k: v for k, v in c.items() if k != "_amr"} for c in cands]
        if chosen is None:
            why = "deferred — no eligible AMR: " + "; ".join(
                f"{c['amr_id']} {c['rejected_reason']}" for c in rows)
        else:
            c = next(r for r in rows if r["amr_id"] == chosen["amr_id"])
            others = [r for r in rows if r["eligible"] and r["amr_id"] != c["amr_id"]]
            bits = ["preferred class for " + task["type"] if c["pref_match"]
                    else "standing in for preferred class"]
            if others:
                bits.append(f"nearest to pickup ({c['distance_m']:.1f} m)"
                            if all(c["distance_m"] <= o["distance_m"] for o in others)
                            else f"{c['distance_m']:.1f} m to pickup")
            else:
                bits.append(f"only eligible AMR ({c['distance_m']:.1f} m to pickup)")
            bits.append(f"battery {c['battery_percent']:.0f}%")
            why = f"{chosen['amr_id']} chosen: " + ", ".join(bits)
        rec = {"decision_id": f"D-{self._decision_no:04d}", "task_id": task["task_id"],
               "task_type": task["type"], "target": task["target"],
               "priority": task["priority"], "sim_tick": self.clock.tick,
               "sim_time": self.clock.sim_time_iso,
               "queue_wait_sec": round((self.clock.tick - task["created_tick"]) * self.clock.dt, 1),
               "chosen": chosen["amr_id"] if chosen else None,
               "rule": "priority → FIFO → preferred class → nearest pickup → amr_id",
               "reason": why, "candidates": rows}
        self.decisions.append(rec)
        del self.decisions[:-DECISION_RING]
        self._emit("AMR", chosen["amr_id"] if chosen else "fleet", "DISPATCH_DECISION", "INFO",
                   f"{rec['decision_id']} {task['task_id']}: {why}")
        return rec

    def _amr_tick(self, dt: float) -> None:
        """§50：每 tick 呼叫。運動學（相位／位置／交通）每 tick 推進；
        下單／收出貨／障礙到期／派工等慢速邏輯維持 0.5 s 決定性節奏（sdt）。"""
        p = self.params
        il = p["intralogistics"]
        rp = p["buffers"]["raw_material"]
        slow = self.clock.tick % SLOW_DECIMATION == 0
        sdt = dt * SLOW_DECIMATION
        if slow:
            self._amr_orders_tick(sdt, il, rp)
        self._amr_motion_tick(dt, il)

    def _amr_orders_tick(self, dt: float, il: dict, rp: dict) -> None:
        p = self.params
        # ---- 1. 下單（reorder point；reserved 防重複下單） ----
        for key in CELL_ORDER:
            r = self.racks[key]
            if r["qty"] + r["reserved"] <= r["reorder_point"] and not \
                    self._pending("CELL_REPLENISH", key):
                r["reserved"] = r["batch"]
                r["stockout_since_order"] = False
                self._order_task("CELL_REPLENISH", key, r["batch"])
            low = r["qty"] < r["low_threshold"]
            if low and not r["material_low"]:
                r["material_low"] = True
                ev = self._emit("CELL", CELL_IDS[key], "MATERIAL_LOW", "MEDIUM",
                                f"{r['sku']} rack at {r['qty']}/{r['capacity']} "
                                f"(low threshold {r['low_threshold']})", cell_id=CELL_IDS[key],
                                value=float(r["qty"]), threshold=float(r["low_threshold"]))
                self._add_alert("MEDIUM", "CELL", CELL_IDS[key],
                                f"{CELL_IDS[key]} Material Low",
                                f"{r['sku']} {r['qty']} left; replenishment "
                                f"{'en route' if r['reserved'] else 'not yet ordered'}",
                                ev["seq"])
            elif not low and r["material_low"]:
                r["material_low"] = False
                self._emit("CELL", CELL_IDS[key], "MATERIAL_RECOVERED", "INFO",
                           f"{r['sku']} rack replenished to {r['qty']}",
                           cell_id=CELL_IDS[key])
                self._resolve_alert(CELL_IDS[key])
        if self.raw_stock < rp["reorder_point"] and not self._pending("RAW_REPLENISH"):
            self._order_task("RAW_REPLENISH", "raw_material", rp["replenishment_batch"])
        fg_free = self.good - self.fg_picked
        if fg_free >= p["amr"]["finished_collect_threshold"] and not self._pending("FG_COLLECT"):
            self._order_task("FG_COLLECT", "finished_goods", p["amr"]["finished_collect_batch"])
        # §45.3/45.4：收貨與出貨事件閉環
        self._receiving_tick(dt)
        self._outbound_tick(dt)
        # §48：空間障礙物到期移除
        for ob in list(self.obstacles):
            if self.clock.tick >= ob["until"]:
                self.obstacles.remove(ob)
                self._emit("ZONE", ob["obstacle_id"], "OBSTACLE_REMOVED", "INFO",
                           f"{ob['obstacle_id']} cleared from {ob['label']}")
                self._resolve_alert(ob["obstacle_id"])
        # §45.8：壓縮機修復（焊接站的 utility_air 故障由 _repair_faults 各自解除）
        if self.compressor_fault_until and self.clock.tick >= self.compressor_fault_until:
            self.compressor_fault_until = 0
            self._emit("UTILITY", "COMPRESSOR", "COMPRESSOR_REPAIRED", "INFO",
                       "Air compressor back online; pressure restored")
            self._resolve_alert("COMPRESSOR")

        # ---- 2. 派工（priority → FIFO；偏好 AMR → 最近者 → amr_id，可互相接替 §39.2） ----
        self.amr_queue.sort(key=lambda t: (t["priority"], t["created_tick"]))
        floor = p["amr_model"].get("dispatch_min_battery_percent",
                                   p["amr_model"]["low_battery_threshold_percent"])
        for task in list(self.amr_queue):
            cands = self._dispatch_candidates(task, floor)
            # 必須依 rank 取車（先前取 AMR 順序的第一台適格者，與紀錄不一致）
            idle = [c["_amr"] for c in sorted((c for c in cands if c["eligible"]),
                                              key=lambda c: c["rank"])]
            if not idle:
                # §51：延後也要留紀錄（每個任務只記一次，之後指派時再記一筆）
                if not task.get("deferred_logged"):
                    task["deferred_logged"] = True
                    self._record_decision(task, cands, None)
                break
            a = idle[0]
            self._record_decision(task, cands, a)
            self.amr_queue.remove(task)
            task["assigned_tick"] = self.clock.tick
            self.fleet_kpi["wait_sec_sum"] += \
                (self.clock.tick - task["created_tick"]) * self.clock.dt
            a["task"] = task
            a["status"] = "DELIVERING"
            a["task_state"] = "TRAVEL_TO_PICKUP"
            self._enter_travel(a)          # §47：路線從當前位置出發；時長=距離/速度
            self._emit("AMR", a["amr_id"], "TASK_STARTED", "INFO",
                       f"{task['task_id']} {task['type']} → {task['target']} "
                       f"assigned to {a['amr_id']}")

    def _amr_motion_tick(self, dt: float, il: dict) -> None:
        p = self.params
        # ---- 3. 任務狀態機推進（每 tick） ----
        speed = il["fleet"]["speed_m_per_s"]
        for a in self.amrs:
            if a["task_state"] == "ERROR":
                if self.clock.tick >= a["fault_until"]:
                    a["task_state"], a["status"] = "IDLE", "IDLE"
                    a["carrying"] = None
                    a["route"], a["route_kind"] = [], "main"
                    self._emit("AMR", a["amr_id"], "REPAIRED", "INFO",
                               f"{a['amr_id']} repaired, back in service")
                    self._resolve_alert(a["amr_id"])
                continue
            if a["task"] is None:
                # §47.2：閒置但不在充電位（如途中修復完畢）→ 先返航，避免堵走廊
                home = AMR_HOME[a["amr_id"]]
                if abs(a["pos"][0] - home[0]) + abs(a["pos"][1] - home[1]) > 0.5:
                    if a["task_state"] != "RETURNING" or len(a["route"]) < 2:
                        a["task_state"] = "RETURNING"
                        self._enter_travel(a)
                    if self._blocked_step(a, dt):       # §53 NO_SAFE_PATH
                        continue
                    if not self._traffic_step(a, dt):
                        continue
                    a["status"] = "RETURNING"
                    self._move_clamped(a, dt)
                    if a["phase_remaining"] <= 0:
                        a["task_state"], a["status"] = "IDLE", "IDLE"
                        a["route"], a["route_kind"] = [], "main"
                    continue
                # 充電／待機
                if a["battery"] < 100.0:
                    a["status"] = "CHARGING" if a["battery"] < 60 else "IDLE"
                    a["task_state"] = a["status"]
                    if a["status"] == "CHARGING":
                        a["kpi"]["charge_sec"] += dt
                    a["battery"] = min(100.0, a["battery"]
                                       + p["amr_model"]["battery_charge_per_min_percent"] * dt / 60)
                else:
                    a["status"], a["task_state"] = "IDLE", "IDLE"
                self._battery_alert(a, p)
                continue

            # dock 互斥：同一 dock 位置一次一台（§39.4 WAITING_FOR_DOCK）
            if a["task_state"] in ("DOCKING_PICKUP", "DOCKING_DROPOFF") and \
                    a["phase_remaining"] == a["phase_total"]:
                loc = self._dock_key(a)

                def _occupies(o: dict) -> bool:
                    if o is a or not o["task"] or self._dock_key(o) != loc:
                        return False
                    if o["task_state"] in ("LOADING", "UNLOADING"):
                        return True
                    if o["task_state"] in ("DOCKING_PICKUP", "DOCKING_DROPOFF"):
                        if o["phase_remaining"] < o["phase_total"]:
                            return True                # 對方已開始停靠
                        return o["amr_id"] < a["amr_id"]   # 同刻抵達 → id 小者先（決定性）
                    return False
                if any(_occupies(o) for o in self.amrs):
                    a["status"] = "WAITING"
                    a["kpi"]["dock_wait_sec"] += dt
                    continue
                a["status"] = "DELIVERING"

            # §46 AMR obstacle：暫停於原地（相位不前進），排除後自動續行
            if a.get("obstacle_until", 0) > self.clock.tick:
                a["status"] = "WAITING"
                a["kpi"]["dock_wait_sec"] += dt
                continue
            if a.get("obstacle_until"):
                a["obstacle_until"] = 0
                self._emit("AMR", a["amr_id"], "OBSTACLE_CLEARED", "INFO",
                           f"{a['amr_id']} path clear, resuming")
                self._resolve_alert(a["amr_id"])

            traveling = a["task_state"].startswith("TRAVEL") \
                or a["task_state"] == "RETURNING"
            # §53：沒有安全路徑 → 原地等待、退避重試（不進交通判斷、不每 tick 重規劃）
            if traveling and self._blocked_step(a, dt):
                continue
            # §47 交通管理：偵測 → 讓行 → 逾時/對頭改道（_traffic_step）
            if traveling and not self._traffic_step(a, dt):
                continue

            a["kpi"]["busy_sec"] += dt
            if traveling:
                before_rem = a["phase_remaining"]
                self._move_clamped(a, dt)
                if a["phase_remaining"] >= before_rem:
                    continue                       # 空間鉗制凍結本 tick
                a["kpi"]["distance_m"] += speed * (before_rem - a["phase_remaining"])
                f = 1.0 - (a["phase_remaining"] / a["phase_total"]
                           if a["phase_total"] else 0.0)
                # 空箱回程：行經 Supermarket 即卸回空箱架（§47.2）
                if a["drop_f"] and f >= a["drop_f"] and a["carrying"] == "empty":
                    self.supermarket["empties"] += 1
                    self._emit("AMR", a["amr_id"], "TOTE_RETURNED", "INFO",
                               f"{a['task']['task_id']} empty tote returned to "
                               f"supermarket ({self.supermarket['empties']} on rack)")
                    a["carrying"] = None
                    a["drop_f"] = 0.0
            else:
                a["phase_remaining"] = max(0.0, a["phase_remaining"] - dt)
            if a["phase_remaining"] > 0:
                continue
            self._advance_task(a)
        # 電量：任務中固定小幅耗電（deterministic）
        drain = p["amr_model"]["battery_drain_per_task_percent"]
        for a in self.amrs:
            # §47：停等（讓行／等 dock／障礙）不耗電（馬達停止）
            if a["task"] is not None and a["task_state"] != "ERROR" \
                    and a["status"] != "WAITING":
                # 以任務全程總時長平均分攤（總時長快取）
                if not hasattr(self, "_task_total_sec"):
                    self._task_total_sec = sum(self._phase_len(ph) for ph in TASK_PHASES)
                a["battery"] = max(0.0, a["battery"] - drain * dt / self._task_total_sec)
                self._battery_alert(a, p)

    def _dock_key(self, a: dict) -> str:
        t = a["task"]
        if a["task_state"] in ("DOCKING_PICKUP", "LOADING"):
            return ("finished_goods" if t["type"] == "FG_COLLECT"
                    else "receiving" if t["type"] == "INBOUND_RESTOCK"
                    else "supermarket")
        return t["target"]

    # -------------------------------------------------- §45.3 Receiving 閉環
    def _receiving_tick(self, dt: float) -> None:
        """外部供應事件鏈：DELIVERY_ARRIVED → DOOR_OPENING → PALLET_RECEIVED →
        RECEIVING_INSPECTION → MATERIAL_REGISTERED →（AMR INBOUND_RESTOCK 取走）。
        一次一批（deterministic）；貨在綠色已驗區等 AMR 於 LOADING 取走。"""
        il = self.params["intralogistics"]
        sm, rcv = il["supermarket"], il["receiving"]
        r = self.receiving
        if r["stage"] == "IDLE":
            if self._pending("INBOUND_RESTOCK"):
                return
            low = [(q, RACK_ORDER.index(sku) if sku in RACK_ORDER else 9, sku)
                   for sku, q in self.supermarket["per_sku"].items()
                   if q < sm["external_supply_threshold"]]
            if not low:
                return
            low.sort()
            r.update(stage="ARRIVED", sku=low[0][2], qty=sm["external_supply_batch"],
                     remaining=rcv["arrival_sec"])
            r["truck_no"] += 1
            self._emit("SIMULATION", "receiving", "DELIVERY_ARRIVED", "INFO",
                       f"Inbound truck IN-{r['truck_no']:03d} arrived with "
                       f"{r['qty']} {r['sku']}")
            return
        if r["stage"] == "WAIT_PICKUP":
            return                                  # 等 AMR LOADING 取走（_advance_task）
        r["remaining"] = max(0.0, r["remaining"] - dt)
        if r["remaining"] > 0:
            return
        if r["stage"] == "ARRIVED":
            r.update(stage="DOOR_OPENING", remaining=rcv["door_sec"])
            self._emit("SIMULATION", "receiving", "DOOR_OPENING", "INFO",
                       "Receiving roll-up door opening")
        elif r["stage"] == "DOOR_OPENING":
            r.update(stage="UNLOADING", remaining=rcv["unload_sec"])
            emp = self.supermarket["empties"]
            self.supermarket["empties"] = 0        # 供應卡車順帶收走空箱（§44.2）
            self._emit("SIMULATION", "receiving", "PALLET_RECEIVED", "INFO",
                       f"Pallet ({r['qty']} {r['sku']}) unloaded to pending area"
                       + (f"; {emp} empty totes collected" if emp else ""))
        elif r["stage"] == "UNLOADING":
            r.update(stage="INSPECTING", remaining=rcv["inspect_sec"])
            self._emit("SIMULATION", "receiving", "RECEIVING_INSPECTION", "INFO",
                       f"Incoming inspection of {r['qty']} {r['sku']} (barcode scan)")
        elif r["stage"] == "INSPECTING":
            r.update(stage="WAIT_PICKUP", remaining=0.0)
            self._emit("SIMULATION", "receiving", "MATERIAL_REGISTERED", "INFO",
                       f"{r['qty']} {r['sku']} registered, moved to accepted area")
            self._order_task("INBOUND_RESTOCK", "supermarket", r["qty"])["sku"] = r["sku"]

    # -------------------------------------------------- §45.4 Outbound 閉環
    def _outbound_tick(self, dt: float) -> None:
        """出貨事件鏈：滿 3 板 → OUTBOUND_ASSIGNED → DOCKED（門開、裝車）→ SHIPPED。"""
        stg = self.params["intralogistics"]["staging"]
        truck = stg["pallet_size"] * stg["pallets_per_truck"]
        o = self.outbound
        if o["stage"] == "IDLE":
            if self.staging_units < truck:
                return
            o.update(stage="ASSIGNED", remaining=stg["outbound_assign_sec"])
            o["truck_no"] += 1
            self._emit("SIMULATION", "staging", "OUTBOUND_ASSIGNED", "INFO",
                       f"Shipment TRUCK-{o['truck_no']:03d} assigned "
                       f"({stg['pallets_per_truck']} pallets ready)")
            return
        o["remaining"] = max(0.0, o["remaining"] - dt)
        if o["remaining"] > 0:
            return
        if o["stage"] == "ASSIGNED":
            o.update(stage="DOCKED", remaining=stg["outbound_load_sec"])
            self._emit("SIMULATION", "staging", "DOCKED", "INFO",
                       f"TRUCK-{o['truck_no']:03d} docked, loading "
                       f"{truck} units (door open)")
        elif o["stage"] == "DOCKED":
            self.staging_units -= truck
            self.outbound_total += truck
            o.update(stage="IDLE", remaining=0.0)
            self._emit("SIMULATION", "staging", "OUTBOUND_SHIPPED", "INFO",
                       f"TRUCK-{o['truck_no']:03d} departed with {truck} units "
                       f"(total outbound {self.outbound_total})")

    def _battery_alert(self, a: dict, p: dict) -> None:
        th = p["amr_model"]["low_battery_threshold_percent"]
        if a["battery"] < th and a["amr_id"] not in self._alerted:
            self._alerted.add(a["amr_id"])
            ev = self._emit("AMR", a["amr_id"], "BATTERY_LOW", "LOW",
                            f"Battery {a['battery']:.0f}% below {th}%",
                            value=round(a["battery"], 1), threshold=float(th))
            self.alerts.append({
                "alert_id": f"AL-{len(self.alerts) + 1:04d}", "severity": "LOW",
                "source_type": "AMR", "source_id": a["amr_id"],
                "title": f"{a['amr_id']} Battery Low",
                "detail": f"Battery at {a['battery']:.0f}%; will charge when idle",
                "sim_time": self.clock.sim_time_iso, "event_seq": ev["seq"],
                "acknowledged": False, "resolved": False})

    def _advance_task(self, a: dict) -> None:
        """相位完成 → 效果生效並進入下一相位（§39.3 步驟 3–9）。"""
        t = a["task"]
        st = a["task_state"]
        nxt = TASK_PHASES[TASK_PHASES.index(st) + 1] if st != "RETURNING" else None
        if st == "LOADING":
            if t["type"] == "FG_COLLECT":
                batch = min(t["batch"], self.good - self.fg_picked)
                t["batch"] = batch
                self.fg_picked += batch                    # 成品離開 finished buffer（在途）
                a["carrying"] = "fg"
            elif t["type"] == "INBOUND_RESTOCK":           # §45.3 已驗收貨 → AMR 棧板
                self.receiving.update(stage="IDLE", sku=None, qty=0, remaining=0.0)
                a["carrying"] = "pallet"
            else:
                sku = RACK_SKU[t["target"]] if t["type"] == "CELL_REPLENISH" else None
                if sku is not None:
                    take = min(t["batch"], self.supermarket["per_sku"][sku])
                    self.supermarket["per_sku"][sku] -= take
                else:
                    take = t["batch"]                      # RAW 由 Receiving Dock 供應
                t["batch"] = take
                a["carrying"] = "full"
            self._emit("AMR", a["amr_id"], "TOTE_LOADED", "INFO",
                       f"{t['task_id']} loaded {t['batch']} @ "
                       f"{'FG buffer' if t['type'] == 'FG_COLLECT' else 'receiving dock' if t['type'] == 'INBOUND_RESTOCK' else 'supermarket'}")
        elif st == "UNLOADING":
            if t["type"] == "CELL_REPLENISH":
                r = self.racks[t["target"]]
                add = min(t["batch"], r["capacity"] - r["qty"])
                r["qty"] += add
                r["reserved"] = 0
                r["last_replenished_time"] = self.clock.sim_time_iso
                on_time = not r["stockout_since_order"]
                self.fleet_kpi["on_time" if on_time else "late"] += 1
                self._emit("AMR", a["amr_id"], "TASK_COMPLETED", "INFO",
                           f"{t['task_id']} delivered {add} {r['sku']} to "
                           f"{t['target']} rack ({'on-time' if on_time else 'LATE'})")
                a["carrying"] = "empty"                    # 空箱回流（§39.5）
            elif t["type"] == "RAW_REPLENISH":
                rp = self.params["buffers"]["raw_material"]
                add = min(t["batch"], rp["capacity"] - self.raw_stock)
                self.raw_stock += add
                self.fleet_kpi["on_time" if self.raw_stock > 0 else "late"] += 1
                self._emit("AMR", a["amr_id"], "TASK_COMPLETED", "INFO",
                           f"{t['task_id']} delivered {add} raw units")
                a["carrying"] = "empty"
            elif t["type"] == "INBOUND_RESTOCK":           # §45.3 入 Supermarket
                sku = t.get("sku") or RACK_ORDER[0]
                cap = self.supermarket["capacity_per_sku"]
                q0 = self.supermarket["per_sku"][sku]
                add = min(t["batch"], cap - q0)
                self.supermarket["per_sku"][sku] = q0 + add
                self.fleet_kpi["on_time"] += 1
                self._emit("AMR", a["amr_id"], "MOVED_TO_SUPERMARKET", "INFO",
                           f"{t['task_id']} stocked {add} {sku} into supermarket "
                           f"({q0 + add}/{cap})")
                a["carrying"] = None
            else:                                           # FG_COLLECT → outbound staging
                stg = self.params["intralogistics"]["staging"]
                before_pallets = self.staging_units // stg["pallet_size"]
                self.shipped += t["batch"]                  # §44.8：卸貨於 Staging 才計 shipped
                self.staging_units += t["batch"]
                self._emit("AMR", a["amr_id"], "TASK_COMPLETED", "INFO",
                           f"{t['task_id']} staged {t['batch']} finished units for outbound")
                after_pallets = self.staging_units // stg["pallet_size"]
                for pn in range(before_pallets + 1, after_pallets + 1):
                    self._emit("SIMULATION", "staging", "PALLET_READY", "INFO",
                               f"Pallet {pn}/{stg['pallets_per_truck']} full "
                               f"({stg['pallet_size']} units)")
                # §45.4：滿 3 板不再瞬時出貨 → _outbound_tick 事件鏈接手
                a["carrying"] = None
        elif st == "RETURNING":
            if a["carrying"] == "empty":       # 保險：drop_f 未觸發時仍歸還空箱
                self.supermarket["empties"] += 1
                self._emit("AMR", a["amr_id"], "TOTE_RETURNED", "INFO",
                           f"{t['task_id']} empty tote returned to supermarket "
                           f"({self.supermarket['empties']} on rack)")
            a["carrying"] = None
            a["kpi"]["tasks_completed"] += 1
            a["task"] = None
            a["task_state"], a["status"] = "IDLE", "IDLE"
            a["route"], a["route_kind"], a["drop_f"] = [], "main", 0.0
            return
        a["task_state"] = nxt
        if nxt in ("TRAVEL_TO_DROPOFF", "RETURNING"):
            self._enter_travel(a)              # §47：路線從當前位置出發
        else:
            a["phase_total"] = a["phase_remaining"] = self._phase_len(nxt)
            a["route"], a["route_kind"] = [], "main"
        if nxt == "RETURNING":
            a["status"] = "RETURNING"

    def facility(self) -> dict:
        """§45.8 廠務設備狀態（全部由引擎狀態／能源帳推導；無假資料）。"""
        e = self.params["energy"]
        comp_fault = self.clock.tick < self.compressor_fault_until
        n = self._n_weld
        charging = sum(1 for a in self.amrs if a["task"] is None and a["status"] == "CHARGING")
        comp = self.assets["COMPRESSOR"]; hv = self.assets["HVAC"]
        ch = self.assets["CHARGER"]; aux = self.assets["AUX"]
        kw_now = getattr(self, "_current_kw", 0.0)
        return {
            "compressor": {
                "asset_id": "COMPRESSOR",
                "state": "FAULT" if comp_fault else ("RUNNING" if n > 0 else "IDLE"),
                "kw": round(comp["kw"], 2), "kwh": round(comp["kwh"], 2),
                # 名目 7.0 bar；每個焊接中站抽降 0.35 bar；故障 → 0（確定性）
                "pressure_bar": 0.0 if comp_fault else round(7.0 - 0.35 * n, 2),
                "active_welders": n,
                "repair_remaining_sec": (round((self.compressor_fault_until - self.clock.tick)
                                               * self.clock.dt) if comp_fault else 0)},
            "hvac": {"asset_id": "HVAC", "state": "RUNNING",
                     "kw": round(hv["kw"], 2), "kwh": round(hv["kwh"], 2),
                     "cooling_load_pct": round(100.0 * hv["kw"] / max(0.1, e["hvac_kw"]), 1),
                     "supply_temp_c": 18.0},
            "fume_extraction": {"asset_id": "FUME-01",
                                "state": "RUNNING" if n > 0 else "STANDBY",
                                "active_hoods": n},
            "mdp": {"asset_id": "MDP-01", "state": "RUNNING",
                    "kw": round(kw_now, 2),
                    "load_pct": round(100.0 * kw_now / max(1.0, e["demand_limit_kw"]), 1),
                    "lighting_kw": round(aux["kw"], 2)},
            "charger": {"asset_id": "CHARGER", "state": "CHARGING" if charging else "IDLE",
                        "kw": round(ch["kw"], 2), "kwh": round(ch["kwh"], 2),
                        "amrs_charging": charging},
        }

    def amr_kpis(self) -> dict:
        """§39.6 物流 KPI（單一來源；全部由引擎計數器推導）。"""
        elapsed = max(1e-9, self.clock.sim_seconds)
        busy = sum(a["kpi"]["busy_sec"] for a in self.amrs)
        done = sum(a["kpi"]["tasks_completed"] for a in self.amrs)
        ot, late = self.fleet_kpi["on_time"], self.fleet_kpi["late"]
        return {
            "utilization_pct": round(busy / (elapsed * len(self.amrs)) * 100, 1),
            "tasks_completed": done,
            "avg_task_wait_sec": round(self.fleet_kpi["wait_sec_sum"] / done, 1) if done else 0.0,
            "on_time_replenishment_pct": round(ot / (ot + late) * 100, 1) if ot + late else 100.0,
            "stockout_min": round(sum(r["stockout_sec"] for r in self.racks.values()) / 60, 1),
            "distance_m": round(sum(a["kpi"]["distance_m"] for a in self.amrs), 1),
            "energy_kwh": round(sum(a["kpi"]["energy_kwh"] for a in self.amrs), 2),
            "charging_min": round(sum(a["kpi"]["charge_sec"] for a in self.amrs) / 60, 1),
            "dock_wait_min": round(sum(a["kpi"]["dock_wait_sec"] for a in self.amrs) / 60, 1),
            "starvation_from_logistics_min":
                round(self.fleet_kpi["starvation_logistics_sec"] / 60, 1),
            "pending_tasks": len(self.amr_queue),
            "per_amr": [{"amr_id": a["amr_id"],
                         "tasks_completed": a["kpi"]["tasks_completed"],
                         "busy_min": round(a["kpi"]["busy_sec"] / 60, 1),
                         "distance_m": round(a["kpi"]["distance_m"], 1),
                         "charging_min": round(a["kpi"]["charge_sec"] / 60, 1),
                         "battery": round(a["battery"], 1)} for a in self.amrs],
        }

    def _tool_health(self, st: dict) -> float:
        h = hashlib.sha256(f"{self.provenance['seed']}:{st['robot_id']}".encode()).digest()
        base = 86 + h[0] % 12
        return max(40.0, base - st["completions"] * 0.02)

    def _maybe_minor_stop(self, key: str, st: dict) -> None:
        ms = self.params["minor_stop"]
        r = self.rng.stream("faults")
        if r.random() < ms["probability_per_cycle"]:
            dur = r.uniform(ms["duration_sec_min"], ms["duration_sec_max"])
            self._start_fault(key, st, "minor_stop", dur, "INFO",
                              f"{st['station_id']} minor stop {dur:.0f}s")

    def _start_fault(self, key: str, st: dict, kind: str, dur_sec: float,
                     severity: str, message: str) -> dict:
        st["fault_kind"] = kind
        st["fault_dur"] = max(1, int(dur_sec / self.clock.dt))
        st["fault_until"] = self.clock.tick + st["fault_dur"]
        st["maint"] = 0                                 # §45.12 維修情境相位（0/1/2）
        prev = st["state"]
        st["state"] = "FAULT"
        ev = self._emit("ROBOT" if kind == "tool_failure" else "STATION",
                        st["robot_id"] if kind == "tool_failure" else st["station_id"],
                        kind.upper(), severity, message, cell_id=CELL_IDS[key])
        self._audit_transition(st["station_id"], prev, "FAULT", kind, ev["seq"])
        if kind == "tool_failure":                      # §45.12：派遣維修人員
            self._emit("STATION", st["station_id"], "MAINTENANCE_DISPATCHED", "INFO",
                       f"Maintenance operator dispatched to {st['station_id']} "
                       f"(est. repair {dur_sec:.0f}s)", cell_id=CELL_IDS[key])
        if st["part_id"] and kind == "tool_failure":
            part = self.parts[st["part_id"]]
            part["lifecycle"] = "HELD"              # §13.3：不得消失、不得算完成
            self._audit_transition(st["part_id"], "PROCESSING", "HELD",
                                   "station fault", ev["seq"])
        return ev

    SAFETY_KINDS = ("safety_gate", "light_curtain", "e_stop", "worker_zone")

    MAINT_ENTRY_FRAC = 0.15          # §45.12：走到 Gate、開門、LOTO 上鎖
    MAINT_EXIT_FRAC = 0.85           # 維修完成、解鎖離開

    def fault_progress(self, st: dict) -> float:
        if not st["fault_kind"] or not st.get("fault_dur"):
            return 0.0
        return max(0.0, min(1.0, 1.0 - (st["fault_until"] - self.clock.tick) / st["fault_dur"]))

    def _repair_faults(self) -> None:
        for key in CELL_ORDER:
            for st in self.cells[key]["stations"]:
                if st["fault_kind"] == "tool_failure":      # §45.12 維修情境事件
                    fp = self.fault_progress(st)
                    if st["maint"] == 0 and fp >= self.MAINT_ENTRY_FRAC:
                        st["maint"] = 1
                        self._emit("STATION", st["station_id"], "MAINTENANCE_ENTRY", "INFO",
                                   f"Operator entered {CELL_IDS[key]} via gate; "
                                   f"LOTO applied on {st['robot_id']}", cell_id=CELL_IDS[key])
                    elif st["maint"] == 1 and fp >= self.MAINT_EXIT_FRAC:
                        st["maint"] = 2
                        self._emit("STATION", st["station_id"], "MAINTENANCE_EXIT", "INFO",
                                   f"Repair done on {st['robot_id']}; LOTO removed, "
                                   f"operator leaving {CELL_IDS[key]}", cell_id=CELL_IDS[key])
                if st["fault_kind"] in self.SAFETY_KINDS:
                    # §46：安全事件不自動復歸——條件解除後進入 awaiting reset
                    if self.clock.tick >= st["fault_until"] and not st.get("await_reset"):
                        st["await_reset"] = True
                        if all(t.get("await_reset") for t in self.cells[key]["stations"]
                               if t["fault_kind"] in self.SAFETY_KINDS):
                            self._emit("CELL", CELL_IDS[key], "SAFETY_AWAITING_RESET", "MEDIUM",
                                       f"{CELL_IDS[key]} safety condition cleared — "
                                       f"operator Reset required to resume",
                                       cell_id=CELL_IDS[key])
                    continue
                if st["fault_kind"] and self.clock.tick >= st["fault_until"]:
                    kind = st["fault_kind"]
                    if kind == "tool_failure" and st["part_id"]:
                        cap = self.params["buffers"]["rework_area"]["capacity"]
                        if len(self.rework) >= cap:
                            continue                # rework 滿：HELD 續留，下 tick 再試
                        pid = st["part_id"]
                        part = self.parts[pid]
                        part["lifecycle"], part["quality"] = "QUEUED", "REWORK_REQUIRED"
                        part["location_type"], part["location_id"] = "REWORK_AREA", "rework_area"
                        self.rework.append({"part_id": pid, "remaining": float(
                            self.params["buffers"]["rework_area"]["rework_time_sec"])})
                        self.rework_events += 1
                        st["part_id"] = None
                        st["elapsed"] = 0.0
                        self._audit_transition(pid, "HELD", "REWORK_REQUIRED",
                                               "sent to rework after repair")
                    st["fault_kind"] = None
                    st["state"] = "PROCESSING" if st["part_id"] else "READY"
                    st["idle_since"] = self.clock.tick
                    self._emit("STATION", st["station_id"], "REPAIRED", "INFO",
                               f"{st['station_id']} repaired ({kind})", cell_id=CELL_IDS[key])
                    self._resolve_alert(st["robot_id"])
                    self._audit_transition(st["station_id"], "FAULT", "READY", "repaired")

    def _resolve_alert(self, source_id: str) -> None:
        for a in self.alerts:
            if a["source_id"] == source_id and not a["resolved"]:
                a["resolved"] = True

    def _add_alert(self, severity: str, source_type: str, source_id: str,
                   title: str, detail: str, seq: int) -> None:
        self.alerts.append({
            "alert_id": f"ALT-{len(self.alerts)+1:04d}", "severity": severity,
            "source_type": source_type, "source_id": source_id,
            "title": title, "detail": detail,
            "sim_time": self.clock.sim_time_iso, "event_seq": seq,
            "acknowledged": False, "resolved": False})

    def _update_cell_states(self) -> None:
        for key in CELL_ORDER:
            sts = self.cells[key]["stations"]
            faults = sum(1 for t in sts if t["fault_kind"] in
                         ("tool_failure", "utility_air") + self.SAFETY_KINDS)
            if faults == len(sts):
                new = "FAULT"
            elif faults:
                new = "DEGRADED"
            elif all(t["state"] == "BLOCKED" for t in sts):
                new = "BLOCKED"
            elif all(t["part_id"] is None and t["state"] == "STARVED" for t in sts):
                new = "STARVED"
            else:
                new = "RUNNING"
            prev = self.cell_states[key]
            if new != prev:
                self.cell_states[key] = new
                sev = {"BLOCKED": "HIGH", "STARVED": "MEDIUM", "DEGRADED": "HIGH",
                       "FAULT": "CRITICAL"}.get(new, "INFO")
                etype = f"CELL_{new}" if new != "RUNNING" else "CELL_RECOVERED"
                ev = self._emit("CELL", CELL_IDS[key], etype, sev,
                                f"{CELL_IDS[key]} {prev} → {new}", cell_id=CELL_IDS[key])
                self._audit_transition(CELL_IDS[key], prev, new, "derived from stations",
                                       ev["seq"])

    # ------------------------------------------------------------ §46 safety reset
    def safety_reset(self, cell_id: str) -> dict:
        """安全事件復歸（§46 驗收：解除後必須經 Reset 才恢復）。actor=operator。"""
        key = {v: k for k, v in CELL_IDS.items()}.get(cell_id)
        if key is None:
            raise ValueError(f"unknown cell {cell_id}")
        done, pending = 0, 0
        for st in self.cells[key]["stations"]:
            if st["fault_kind"] not in self.SAFETY_KINDS:
                continue
            if self.clock.tick < st["fault_until"]:
                pending += 1                    # 條件仍存在（門仍開/光柵仍被遮斷）
                continue
            kind = st["fault_kind"]
            st["fault_kind"] = None
            st["await_reset"] = False
            st["state"] = "PROCESSING" if st["part_id"] else "READY"
            st["idle_since"] = self.clock.tick
            done += 1
            self._audit_transition(st["station_id"], "FAULT", st["state"],
                                   f"safety reset ({kind})")
        if done:
            ev = self._emit("CELL", cell_id, "SAFETY_RESET", "INFO",
                            f"{cell_id} reset by operator — {done} station(s) resumed",
                            cell_id=cell_id)
            self.audit.record(sim_time=self.clock.sim_time_iso, actor="operator",
                              source=cell_id, action="SAFETY_RESET",
                              previous_state="FAULT", new_state="RUNNING",
                              reason="operator reset", event_seq=ev["seq"])
            self._resolve_alert(cell_id)
        return {"reset_stations": done, "condition_active": pending}

    def _start_safety(self, cell_id: str, kind: str, event_type: str, severity: str,
                      dur: float, message: str) -> dict:
        key = {v: k for k, v in CELL_IDS.items()}.get(cell_id)
        if key is None:
            raise ValueError(f"unknown cell {cell_id}")
        ev = self._emit("CELL", cell_id, event_type, severity, message, cell_id=cell_id)
        for st in self.cells[key]["stations"]:
            # 安全停止優先於 minor_stop（升級覆蓋）；tool_failure/utility 站已停不覆蓋
            if st["fault_kind"] is None or st["fault_kind"] == "minor_stop":
                st["fault_kind"] = kind
                st["fault_dur"] = max(1, int(dur / self.clock.dt))
                st["fault_until"] = self.clock.tick + st["fault_dur"]
                st["await_reset"] = False
                prev = st["state"]
                st["state"] = "FAULT"
                self._audit_transition(st["station_id"], prev, "FAULT", kind, ev["seq"])
        self._add_alert(severity, "CELL", cell_id, f"{cell_id} {event_type.replace('_', ' ').title()}",
                        message + " — Reset required after condition clears", ev["seq"])
        self.audit.record(sim_time=self.clock.sim_time_iso, actor="operator",
                          source=cell_id, action="FAILURE_INJECTED",
                          previous_state="RUNNING", new_state="SAFETY_STOP",
                          reason=kind, event_seq=ev["seq"])
        return ev

    # ------------------------------------------------------------ §46 part trace
    ROUTE = ["WELDING", "ASSEMBLY", "MACHINING", "INSPECTION"]

    def part_trace(self, part_id: str) -> dict:
        """§46：單一工件追溯（只回傳引擎真的知道的欄位；無假資料）。"""
        p = self.parts.get(part_id)
        if p is None:
            raise KeyError(part_id)
        op = p.get("operation")
        idx = self.ROUTE.index(op) if op in self.ROUTE else (
            len(self.ROUTE) if p["lifecycle"] == "COMPLETED" else 0)
        route = [{"operation": o,
                  "status": ("DONE" if i < idx or p["lifecycle"] == "COMPLETED"
                             else "CURRENT" if i == idx and p["lifecycle"] != "COMPLETED"
                             else "PENDING")}
                 for i, o in enumerate(self.ROUTE)]
        return {
            "part_id": part_id,
            "lifecycle_state": p["lifecycle"], "quality_state": p["quality"],
            "operation": op,
            "location": {"type": p["location_type"], "id": p["location_id"]},
            "route": route,
            "age_sec": round((self.clock.tick - p["created_tick"]) * self.clock.dt, 1),
            "first_inspected": p.get("first_inspected", False),
            "carrier": None,          # 誠實：AMR 載運以批次計，引擎不追個別 part 的載具
            "sim_time": self.clock.sim_time_iso,
        }

    def parts_active(self, limit: int = 60) -> list[dict]:
        out = []
        for pid, p in self.parts.items():
            if p["lifecycle"] in ("COMPLETED",):
                continue
            out.append({"part_id": pid, "lifecycle_state": p["lifecycle"],
                        "operation": p.get("operation"),
                        "location": {"type": p["location_type"], "id": p["location_id"]}})
            if len(out) >= limit:
                break
        return out

    # ------------------------------------------------------------ failure injection（§20）
    def inject(self, failure_type: str, target_id: str,
               duration_sec: float | None = None,
               extra: dict | None = None) -> dict:
        """使用者故障注入：User Event 經引擎生效，寫入 Audit（actor=operator）。"""
        f = self.params["failures"]
        extra = extra or {}
        if failure_type == "zone_obstacle":                 # §48 空間障礙物
            if target_id in OBSTACLE_SITES:
                x, z, label = OBSTACLE_SITES[target_id]
            elif "x" in extra and "z" in extra:
                x, z, label = float(extra["x"]), float(extra["z"]), "custom position"
            else:
                raise ValueError(f"unknown obstacle site {target_id}")
            radius = float(extra.get("radius", f.get("zone_obstacle_radius_m", 1.5)))
            dur = duration_sec or f.get("zone_obstacle_sec", 90)
            # §49：放置驗證——半徑必須為正；不得生成在 AMR 車身／
            # 安全距內、dock 正位上、或與既有障礙重疊（拒絕並說明，而非靜默卡車）
            if not (0.3 <= radius <= 4.0):
                raise ValueError(f"obstacle radius must be 0.3–4.0 m (got {radius})")
            if not (FLOOR["x_min"] <= x <= FLOOR["x_max"] and FLOOR["z_min"] <= z <= FLOOR["z_max"]):
                raise ValueError(f"obstacle position ({x:.1f}, {z:.1f}) outside AMR floor")
            hs = self._traffic()["hard_stop_m"]
            # §53：淨空若同時蓋住主／備援走廊的全部車道 → 沒有任何 AMR 能通過，
            # 拒絕放置（而不是讓 AMR 進入永久 NO_SAFE_PATH）。兩個各自合法的障礙仍可能合起來封路，
            # 那種情況由 _blocked_step 的退避語意處理。
            tr_ = self._traffic()
            lanes = [AMR_CORRIDOR_Z + dz + off
                     for dz in (0.0, tr_["alt_corridor_dz"])
                     for off in (-tr_["lane_offset_m"], tr_["lane_offset_m"])]
            if all(abs(z - lz) < radius + hs for lz in lanes):
                raise ValueError(
                    f"obstacle at z={z:.1f} with clearance {radius + hs:.1f} m would block every "
                    f"corridor lane (z {min(lanes):.1f}–{max(lanes):.1f}); reduce the radius or move it")
            for a in self.amrs:
                d = ((a["pos"][0] - x) ** 2 + (a["pos"][1] - z) ** 2) ** 0.5
                if d < radius + hs:
                    raise ValueError(
                        f"{a['amr_id']} is {d:.1f} m from the obstacle site "
                        f"(< {radius + hs:.1f} m clearance) — wait for it to pass")
            for key, (dx_, dz_) in AMR_DOCKS.items():
                if ((dx_ - x) ** 2 + (dz_ - z) ** 2) ** 0.5 < radius + 1.0:
                    raise ValueError(f"obstacle would block dock '{key}'")
            for other in self.obstacles:
                if ((other["x"] - x) ** 2 + (other["z"] - z) ** 2) ** 0.5 \
                        < radius + other["radius"]:
                    raise ValueError(f"overlaps existing {other['obstacle_id']}")
            self._obs_no += 1
            ob = {"obstacle_id": f"OBS-{self._obs_no:03d}", "x": x, "z": z,
                  "radius": radius, "label": label,
                  "until": self.clock.tick + int(dur / self.clock.dt)}
            self.obstacles.append(ob)
            ev = self._emit("ZONE", ob["obstacle_id"], "OBSTACLE_PLACED", "MEDIUM",
                            f"{ob['obstacle_id']} placed at {label} "
                            f"({x:.1f}, {z:.1f}; r={radius:.1f} m; {dur:.0f}s)")
            self._add_alert("MEDIUM", "ZONE", ob["obstacle_id"],
                            f"Obstacle {ob['obstacle_id']}",
                            f"{label} blocked; AMRs replanning around it", ev["seq"])
            self.audit.record(sim_time=self.clock.sim_time_iso, actor="operator",
                              source=ob["obstacle_id"], action="FAILURE_INJECTED",
                              previous_state="CLEAR", new_state="BLOCKED",
                              reason="zone_obstacle", event_seq=ev["seq"])
            # 因果：目前路線穿越障礙淨空的 AMR 立即重規劃（§53：無安全路徑則進入 NO_SAFE_PATH，
            # 由 _blocked_step 發單一事件，不宣稱改道）
            for a in self.amrs:
                if len(a["route"]) >= 2 and self._route_hits_obstacle(a, ob):
                    ok = self._enter_travel(a, alt=(a["route_kind"] == "main"))
                    self._after_reroute(a)
                    if ok:
                        self._emit("AMR", a["amr_id"], "AMR_REROUTED", "INFO",
                                   f"{a['amr_id']} rerouted: {ob['obstacle_id']} on "
                                   f"planned route")
            return ev
        if failure_type == "conveyor_jam":
            if target_id not in self.conv_state:
                raise ValueError(f"unknown conveyor {target_id}")
            dur = duration_sec or f["conveyor_jam_default_sec"]
            cs = self.conv_state[target_id]
            cs["status"] = "JAMMED"
            cs["jam_until"] = self.clock.tick + int(dur / self.clock.dt)
            cs["full_emitted"] = False
            ev = self._emit("CONVEYOR", target_id, "CONVEYOR_JAMMED", "HIGH",
                            f"{target_id} jammed (injected, {dur:.0f}s)")
            self._add_alert("HIGH", "CONVEYOR", target_id,
                            f"Conveyor {target_id} Jammed",
                            f"Injected jam, est. repair {dur:.0f}s", ev["seq"])
            self.audit.record(sim_time=self.clock.sim_time_iso, actor="operator",
                              source=target_id, action="FAILURE_INJECTED",
                              previous_state="RUNNING", new_state="JAMMED",
                              reason="conveyor_jam", event_seq=ev["seq"])
            return ev
        if failure_type == "tool_failure":
            for key in CELL_ORDER:
                for st in self.cells[key]["stations"]:
                    if st["robot_id"] == target_id:
                        dur = duration_sec or f["tool_failure_repair_sec"]
                        ev = self._start_fault(key, st, "tool_failure", dur, "CRITICAL",
                                               f"{target_id} tool failure (injected)")
                        self._add_alert("CRITICAL", "ROBOT", target_id,
                                        f"{target_id} Tool Failure",
                                        f"Cycle aborted; repair est. {dur:.0f}s", ev["seq"])
                        self.audit.record(sim_time=self.clock.sim_time_iso, actor="operator",
                                          source=target_id, action="FAILURE_INJECTED",
                                          previous_state="RUNNING", new_state="ERROR",
                                          reason="tool_failure", event_seq=ev["seq"])
                        return ev
            raise ValueError(f"unknown robot {target_id}")
        if failure_type == "light_curtain":                 # §46：光柵遮斷
            dur = duration_sec or f.get("light_curtain_clear_sec", 15)
            return self._start_safety(target_id, "light_curtain", "LIGHT_CURTAIN_INTERRUPTED",
                                      "HIGH", dur,
                                      f"Light curtain interrupted on {target_id}; "
                                      f"all robots safety-stopped")
        if failure_type == "emergency_stop":                # §46：E-Stop（立即鎖存）
            return self._start_safety(target_id, "e_stop", "EMERGENCY_STOP", "CRITICAL",
                                      duration_sec or self.clock.dt,
                                      f"Emergency stop pressed on {target_id}")
        if failure_type == "worker_in_zone":                # §46：人員進入受限區
            dur = duration_sec or f.get("worker_zone_clear_sec", 20)
            return self._start_safety(target_id, "worker_zone", "WORKER_IN_RESTRICTED_ZONE",
                                      "HIGH", dur,
                                      f"Worker entered restricted zone of {target_id}; "
                                      f"robots safety-stopped")
        if failure_type == "amr_obstacle":                  # §46：AMR 路徑障礙
            for a in self.amrs:
                if a["amr_id"] == target_id:
                    dur = duration_sec or f.get("amr_obstacle_sec", 45)
                    a["obstacle_until"] = self.clock.tick + int(dur / self.clock.dt)
                    ev = self._emit("AMR", target_id, "AMR_OBSTACLE", "MEDIUM",
                                    f"{target_id} blocked by obstacle on path "
                                    f"(est. clear {dur:.0f}s)")
                    self._add_alert("MEDIUM", "AMR", target_id, f"{target_id} Obstacle",
                                    f"Path blocked; waiting {dur:.0f}s", ev["seq"])
                    self.audit.record(sim_time=self.clock.sim_time_iso, actor="operator",
                                      source=target_id, action="FAILURE_INJECTED",
                                      previous_state="DELIVERING", new_state="WAITING",
                                      reason="amr_obstacle", event_seq=ev["seq"])
                    return ev
            raise ValueError(f"unknown AMR {target_id}")
        if failure_type == "compressor_fault":              # §45.8
            dur = duration_sec or f.get("compressor_fault_sec", 90)
            self.compressor_fault_until = self.clock.tick + int(dur / self.clock.dt)
            ev = self._emit("UTILITY", "COMPRESSOR", "COMPRESSOR_FAULT", "HIGH",
                            f"Air compressor tripped; welding stations lose compressed "
                            f"air (est. repair {dur:.0f}s)")
            for st in self.cells["welding"]["stations"]:
                if st["fault_kind"] is None:
                    self._start_fault("welding", st, "utility_air", dur, "HIGH",
                                      f"{st['station_id']} no compressed air (compressor fault)")
            self._add_alert("HIGH", "UTILITY", "COMPRESSOR", "Air Compressor Fault",
                            f"Welding cell without compressed air; est. repair {dur:.0f}s",
                            ev["seq"])
            self.audit.record(sim_time=self.clock.sim_time_iso, actor="operator",
                              source="COMPRESSOR", action="FAILURE_INJECTED",
                              previous_state="RUNNING", new_state="FAULT",
                              reason="compressor_fault", event_seq=ev["seq"])
            return ev
        if failure_type == "safety_gate_open":          # §36.9 → §46 Reset 語意
            dur = duration_sec or 60
            return self._start_safety(target_id, "safety_gate", "SAFETY_GATE_OPEN", "HIGH",
                                      dur, f"Safety gate opened on {target_id}; "
                                      f"all robots safety-stopped")
        if failure_type == "amr_fault":
            for a in self.amrs:
                if a["amr_id"] == target_id:
                    dur = duration_sec or 300
                    if a["task"] is not None:      # 任務退回佇列（§39.2 另一台可接替）
                        t = a["task"]
                        t["assigned_tick"] = None
                        if a["carrying"] == "fg":  # 在途成品歸還 FG buffer（守恆）
                            self.fg_picked -= t["batch"]
                        elif a["carrying"] == "full" and t["type"] == "CELL_REPLENISH":
                            self.supermarket["per_sku"][RACK_SKU[t["target"]]] += t["batch"]
                        self.amr_queue.append(t)
                        self.fleet_kpi["cancelled"] += 1
                        self._emit("AMR", a["amr_id"], "TASK_CANCELLED", "MEDIUM",
                                   f"{t['task_id']} cancelled and re-queued "
                                   f"({a['amr_id']} fault)")
                        a["task"] = None
                    a["carrying"] = None
                    a["status"], a["task_state"] = "ERROR", "ERROR"
                    a["route"], a["route_kind"], a["drop_f"] = [], "main", 0.0
                    a["yielding"], a["yield_since"], a["yield_event"] = False, 0.0, False
                    a["fault_until"] = self.clock.tick + int(dur / self.clock.dt)
                    ev = self._emit("AMR", a["amr_id"], "ROBOT_ERROR", "HIGH",
                                    f"{a['amr_id']} fault (injected, {dur:.0f}s)")
                    self._add_alert("HIGH", "AMR", a["amr_id"], f"{a['amr_id']} Fault",
                                    f"AMR out of service; est. repair {dur:.0f}s", ev["seq"])
                    self.audit.record(sim_time=self.clock.sim_time_iso, actor="operator",
                                      source=target_id, action="FAILURE_INJECTED",
                                      previous_state="IDLE", new_state="ERROR",
                                      reason="amr_fault", event_seq=ev["seq"])
                    return ev
            raise ValueError(f"unknown AMR {target_id}")
        if failure_type == "minor_stop":
            for key in CELL_ORDER:
                for st in self.cells[key]["stations"]:
                    if st["station_id"] == target_id and st["fault_kind"] is None:
                        return self._start_fault(key, st, "minor_stop",
                                                 duration_sec or 30, "LOW",
                                                 f"{target_id} minor stop (injected)")
            raise ValueError(f"station {target_id} unavailable")
        raise ValueError(f"unknown failure_type {failure_type}")

    def _bookkeeping_slow(self, dt: float) -> None:
        """0.5 s 節奏的簿記：cell state 推導、starvation／stockout 累計、能源積分。
        dt 已放大 SLOW_DECIMATION 倍，時間積分等價。"""
        self._update_cell_states()
        for name, buf in self.inter.items():           # §40 buffer 連續滿載秒數
            cap = self.params["buffers"][name]["capacity"]
            self.buf_full_sec[name] = self.buf_full_sec[name] + dt if len(buf) >= cap else 0.0
        # ---- 生產狀態簿記（每 tick）：starvation／stockout／idle·fault 累計 ----
        for key in CELL_ORDER:
            material_out = self.racks[key]["qty"] <= 0
            if material_out:                        # §39.6 stockout 分鐘數（rack 級）
                self.racks[key]["stockout_sec"] += dt
                self.racks[key]["stockout_since_order"] = True
            input_empty = (self.raw_stock <= 0) if key == "welding" else \
                not self.inter[self.inter_after[CELL_ORDER[CELL_ORDER.index(key) - 1]]]
            for st in self.cells[key]["stations"]:
                if st["fault_kind"] is not None:
                    st["fault_time"] += dt
                    continue
                if st["part_id"] is None:
                    st["idle_time"] += dt
                    if input_empty or material_out:
                        if st["state"] == "READY":
                            self._transition(st, key, "STARVED",
                                             "material stockout" if material_out
                                             else "input empty")
                        if st["state"] == "STARVED":
                            st["starved_time"] += dt
                            if material_out:      # §39.6 物流造成的挨餓（歸因）
                                self.fleet_kpi["starvation_logistics_sec"] += dt

        # ---- §41 Per-asset Power（0.5 s 取樣積分；總量 = 各資產之和） ----
        e = self.params["energy"]
        er, ew, ec, ev, ecv = e["robot"], e["welding_controller"], e["cnc"], \
            e["vision"], e["conveyor"]
        pol = self.energy_policy
        standby_after = e["policies"]["robot_standby_after_idle_sec"]
        f = dt / 3600.0                       # dt 已是 0.5 s
        kw = 0.0

        def _pw(a3: dict, kw2: float, waste: bool = False) -> None:
            nonlocal kw
            a3["kw"] = kw2
            a3["kwh"] += kw2 * f
            if waste:
                a3["idle_kwh"] += kw2 * f
            kw += kw2

        _pw(self._aux_asset, e["base_load_kw"])
        n_weld = 0                            # v7：正在焊接的站數（壓縮機負載跟隨）
        rob_standby = "robot_auto_standby" in pol
        cnc_standby = "cnc_standby" in pol
        for key in CELL_ORDER:
            cycle = self.cells[key]["cycle"]
            refs = self._st_assets[key]
            for i, st in enumerate(self.cells[key]["stations"]):
                ar, am, aw, av = refs[i]
                if st["fault_kind"] is not None:
                    _pw(ar, er["fault"])
                    if am:
                        _pw(am, ec["fault"])
                    if aw:
                        _pw(aw, ew["standby"])
                    if av:
                        _pw(av, ev["idle"])
                    continue
                if st["part_id"] is None:
                    sb = rob_standby and \
                        (self.clock.tick - st["idle_since"]) * dt > standby_after
                    _pw(ar, er["standby"] if sb else er["idle"], waste=not sb)
                    if am:
                        _pw(am, ec["standby"] if cnc_standby else ec["idle"],
                            waste=not cnc_standby)
                    if aw:
                        _pw(aw, ew["standby"])
                    if av:
                        _pw(av, ev["idle"])
                else:
                    phase = self._phase(key, st["elapsed"])
                    done = st["elapsed"] + 1e-9 >= cycle      # 完工等待卸料（BLOCKED）
                    if done:
                        sb = rob_standby and st["elapsed"] - cycle > standby_after
                        # §41.6 blocked 只耗 idle 功率；政策啟用且超過門檻 → standby
                        _pw(ar, er["standby"] if sb else er["idle"], waste=not sb)
                    elif phase == "WAITING_MACHINE":
                        _pw(ar, er["waiting"])
                    else:
                        _pw(ar, er["active"])
                    if am:
                        mkw = (ec["machining"] if phase == "WAITING_MACHINE" else
                               ec["door_open"] if phase in ("OPEN_MACHINE", "CLOSE_MACHINE")
                               else ec["idle"])
                        _pw(am, mkw, waste=(mkw == ec["idle"] and done))
                    if aw:
                        wkw = (ew["welding"] if phase == "WELDING" and not done else
                               ew["positioning"] if phase in ("MOVE_TO_APPROACH",
                                                              "POSITIONING") and not done
                               else ew["standby"])
                        if wkw == ew["welding"]:
                            n_weld += 1
                        _pw(aw, wkw)
                    if av:
                        vkw = ev["active"] if phase in ("CAPTURE_IMAGE", "INSPECTING") \
                            and not done else ev["idle"]
                        _pw(av, vkw)
        conv_stop = "conveyor_stop_when_starved" in pol
        for j, cid in enumerate(CONVEYORS):
            cs = self.conv_state[cid]
            empty = len(self.conveyors[cid]) == 0
            ac = self._conv_assets[j]
            if cs["status"] == "JAMMED":
                _pw(ac, ecv["jammed"])
            elif conv_stop and empty:
                _pw(ac, ecv["stopped"])
            else:
                _pw(ac, ecv["running"], waste=empty)          # 空轉 = idle waste
        il = self.params["intralogistics"]
        charging = 0
        for j, a in enumerate(self.amrs):
            akw = il["amr_energy_kw_moving"] if a["task"] is not None \
                else il["amr_energy_kw_idle"]
            if a["task"] is None and a["status"] == "CHARGING":
                charging += 1
            _pw(self._amr_assets[j], akw)
            a["kpi"]["energy_kwh"] += akw * f
        _pw(self._charger_asset, charging * e["amr_charger_kw"])
        eca = e["compressed_air"]             # v7 §44.10：壓縮空氣隨焊接活動
        self._n_weld = n_weld
        comp_fault = self.clock.tick < self.compressor_fault_until
        _pw(self._compressor_asset,
            0.0 if comp_fault else eca["base_kw"] + n_weld * eca["per_active_welder_kw"])
        _pw(self._hvac_asset, e["hvac_kw"])   # v7 §44.10：HVAC 常載
        self.energy_kwh += kw * f
        self.peak_kw = max(self.peak_kw, kw)
        self._current_kw = kw

    def _phase(self, key: str, elapsed: float) -> str:
        t = 0.0
        for name, dur in PHASES[key]:
            t += dur
            if elapsed < t:
                return name
        return PHASES[key][-1][0]

    def _flush_minute(self) -> None:
        m = self.clock.sim_minute_of_day - 1          # 剛結束的那一分鐘
        k = self.kpis()
        self.history.append({
            "sim_minute": f"{m // 60:02d}:{m % 60:02d}",
            "good_units": self.good - self._min_good0,
            "defect_units": self.first_pass_fails - self._min_fail0,
            "throughput_uph": round((self.good - self._min_good0) * 60, 1),
            "oee": round(k["oee"]["oee"], 4),
            "defect_rate": round(k["defect_rate"], 4),
            "energy_kw": round((self.energy_kwh - self._min_kwh0) * 60, 1),
            "wip": self.wip(),
        })
        self._min_good0 = self.good
        self._min_fail0 = self.first_pass_fails
        self._min_kwh0 = self.energy_kwh
        # §40 flow history（每分鐘一筆，保留 480）
        cell_uph, util = {}, {}
        for key in CELL_ORDER:
            comp = sum(t["completions"] for t in self.cells[key]["stations"])
            busy = sum(t["busy_time"] for t in self.cells[key]["stations"])
            n = len(self.cells[key]["stations"])
            cell_uph[key] = round((comp - self._min_cell0[key]) * 60, 1)
            util[key] = round((busy - self._min_busy0[key]) / (60.0 * n), 3)
            self._min_cell0[key] = comp
            self._min_busy0[key] = busy
        fleet_done = sum(a["kpi"]["tasks_completed"] for a in self.amrs)
        gk: dict[str, float] = {}
        for a4 in self.assets.values():
            gk[a4["group"]] = gk.get(a4["group"], 0.0) + a4["kwh"]
        if not hasattr(self, "_min_group0"):
            self._min_group0 = {}
        kw_by_group = {g: round((v - self._min_group0.get(g, 0.0)) * 60, 2)
                       for g, v in gk.items()}
        self._min_group0 = gk
        blocked = sum(1 for k2 in CELL_ORDER for t in self.cells[k2]["stations"]
                      if t["state"] == "BLOCKED")
        starved = sum(1 for k2 in CELL_ORDER for t in self.cells[k2]["stations"]
                      if t["state"] == "STARVED")
        self.flow_history.append({
            "m": self.history[-1]["sim_minute"] if self.history else "",
            "cell_uph": cell_uph, "util": util,
            "pacemaker": max(CELL_ORDER, key=lambda k2: util[k2]),
            "buf": {"raw": self.raw_stock,
                    "b1": len(self.inter["welding_to_assembly"]),
                    "b2": len(self.inter["assembly_to_machining"]),
                    "b3": len(self.inter["machining_to_inspection"]),
                    "rework": len(self.rework),
                    "fg": self.good - self.fg_picked},
            "rack": {k2: self.racks[k2]["qty"] for k2 in CELL_ORDER},
            "blocked": blocked, "starved": starved,
            "amr_pending": len(self.amr_queue),
            "amr_delivered": fleet_done - self._min_fleet0,
            "kw_by_group": kw_by_group,
        })
        self._min_fleet0 = fleet_done
        if len(self.flow_history) > 480:
            self.flow_history = self.flow_history[-480:]

    # ------------------------------------------------------------ KPI（§18，單一來源）
    def kpis(self) -> dict:
        p = self.params
        planned = min(self.clock.sim_seconds, p["shift"]["length_hours"] * 3600)
        runtime = max(1e-9, planned - self.downtime_sec)
        mt = p["cells"]["machine_tending"]["station_cycle_sec"]
        ideal = sum(mt.values()) / len(p["cells"]["machine_tending"]["stations"])
        total = self.good + self.scrap
        mt_sts = self.cells["machine_tending"]["stations"]
        mt_fault = sum(t["fault_time"] for t in mt_sts) / len(mt_sts)
        self.downtime_sec = mt_fault            # 定義：瓶頸（pacemaker）故障時間 = 線體 downtime
        planned = min(self.clock.sim_seconds, p["shift"]["length_hours"] * 3600)
        runtime = max(1e-9, planned - self.downtime_sec)
        availability = runtime / max(planned, 1e-9) if planned > 0 else 1.0
        performance = min(1.0, ideal * total / runtime)
        quality = self.good / total if total else 1.0
        fpy = ((self.first_pass_inspections - self.first_pass_fails)
               / self.first_pass_inspections) if self.first_pass_inspections else 1.0
        return {
            "total_output": total, "good_units": self.good,
            "defect_units": self.first_pass_fails, "rework_units": self._rework_wip(),
            "wip": self.wip(),
            "throughput_uph": round(self.good / (runtime / 3600), 1) if runtime > 60 else 0.0,
            "takt_time_sec": round(p["shift"]["length_hours"] * 3600
                                   / p["target_good_units_per_shift"], 1),
            "target_good_units": p["target_good_units_per_shift"],
            "first_pass_yield": round(fpy, 4), "defect_rate": round(1 - fpy, 4),
            "oee": {"availability": round(availability, 4), "performance": round(performance, 4),
                    "quality": round(quality, 4),
                    "oee": round(availability * performance * quality, 4), "target_oee": 0.85},
            "runtime_sec": round(runtime, 1), "downtime_sec": round(self.downtime_sec, 1),
            "planned_time_sec": round(planned, 1),
            "avg_lead_time_sec": (round(sum(self.lead_samples) / len(self.lead_samples), 1)
                                  if self.lead_samples else 0.0),
            "energy_kwh_total": round(self.energy_kwh, 1),
            "idle_waste_kwh": round(sum(a["idle_kwh"] for a in self.assets.values()), 2),
            "baseline_kw": self.baseline_kw(),
            # delta 以「最近 10 分鐘平均 kW」對比 baseline（瞬時值受相位同步影響太大）
            "baseline_delta_pct": round(((sum(h["energy_kw"] for h in self.history[-10:])
                                          / len(self.history[-10:]) if self.history
                                          else getattr(self, "_current_kw", 0.0))
                                         - self.baseline_kw()) / self.baseline_kw() * 100, 1),
            "demand_limit_kw": float(p["energy"]["demand_limit_kw"]),
            "units_per_kwh": round(self.good / self.energy_kwh, 2) if self.energy_kwh else 0.0,
            "energy_kwh_per_unit": round(self.energy_kwh / self.good, 3) if self.good else 0.0,
            "energy_kw_current": round(getattr(self, "_current_kw", 0.0), 1),
            "peak_demand_kw": round(self.peak_kw, 1),
        }

    # ------------------------------------------------------------ §40.3 flow insight
    CELL_LABEL = {"welding": "Welding", "assembly": "Assembly",
                  "machine_tending": "Machine Tending",
                  "vision_inspection": "Vision Inspection"}
    BUF_LABEL = {"welding_to_assembly": "B01 (Welding→Assembly)",
                 "assembly_to_machining": "B02 (Assembly→Machine Tending)",
                 "machining_to_inspection": "B03 (Machine Tending→Inspection)"}

    def flow_insight(self) -> dict:
        """量化瓶頸成因（§40.3；權威=引擎；英文與 Copilot 一致）。"""
        recent = self.flow_history[-10:]
        if recent:
            rate = {k: round(sum(h["cell_uph"][k] for h in recent) / len(recent), 1)
                    for k in CELL_ORDER}
            util = {k: round(sum(h["util"][k] for h in recent) / len(recent), 3)
                    for k in CELL_ORDER}
        else:
            rate = {k: 0.0 for k in CELL_ORDER}
            util = {k: 0.0 for k in CELL_ORDER}
        bneck = max(CELL_ORDER, key=lambda k: util[k])
        up_idx = CELL_ORDER.index(bneck) - 1
        upstream = CELL_ORDER[up_idx] if up_idx >= 0 else None
        in_buf = {"assembly": "welding_to_assembly",
                  "machine_tending": "assembly_to_machining",
                  "vision_inspection": "machining_to_inspection"}.get(bneck)
        full_sec = round(self.buf_full_sec.get(in_buf, 0.0), 0) if in_buf else 0.0
        blocked_up = sum(1 for t in self.cells[upstream]["stations"]
                         if t["state"] == "BLOCKED") if upstream else 0
        n_up = len(self.cells[upstream]["stations"]) if upstream else 0
        avg_util = sum(util.values()) / len(util)
        lbl = self.CELL_LABEL
        reason = (f"{lbl[bneck]} is the current constraint: utilization "
                  f"{util[bneck] * 100:.0f}% vs line average {avg_util * 100:.0f}%. ")
        if upstream:
            cap_up = round(len(self.cells[upstream]["stations"]) * 3600
                           / self.cells[upstream]["cycle"], 0)
            cap_bn = round(len(self.cells[bneck]["stations"]) * 3600
                           / self.cells[bneck]["cycle"], 0)
            reason += (f"Its standalone capacity is {cap_bn:.0f} u/h — the lowest on the "
                       f"line — while upstream {lbl[upstream]} could produce "
                       f"{cap_up:.0f} u/h, so the line paces at {rate[bneck]} u/h. ")
        if in_buf and full_sec > 0:
            reason += (f"{self.BUF_LABEL[in_buf]} has remained full for {full_sec:.0f} "
                       f"seconds, blocking {blocked_up} of {n_up} {lbl[upstream]} stations.")
        elif in_buf:
            reason += f"{self.BUF_LABEL[in_buf]} is currently not saturated."
        low_racks = [f"{self.racks[k]['sku']} {self.racks[k]['qty']}"
                     for k in CELL_ORDER if self.racks[k]["material_low"]]
        if low_racks:
            reason += f" Material risk: {', '.join(low_racks)} below low threshold."
        return {
            "bottleneck": CELL_IDS[bneck], "bottleneck_name": lbl[bneck],
            "reason": reason,
            "rates_uph": {CELL_IDS[k]: rate[k] for k in CELL_ORDER},
            "utilization": {CELL_IDS[k]: util[k] for k in CELL_ORDER},
            "buffer_full_sec": {b: round(v, 0) for b, v in self.buf_full_sec.items()},
            "blocked_upstream_stations": blocked_up,
            "window_min": len(recent),
            "cycle_p95_sec": {CELL_IDS[k]: (round(sorted(v)[int(len(v) * .95) - 1], 1)
                                            if len(v) >= 20 else None)
                              for k, v in self.cycle_samples.items()},
            "cycle_samples": {CELL_IDS[k]: v for k, v in self.cycle_samples.items()},
        }

    # ------------------------------------------------------------ §41 energy analytics
    def baseline_kw(self) -> float:
        """§41.2 Baseline Power：由參數模型在名目節拍下的解析期望值（deterministic，
        非實測移動平均）。duty(cell) = 瓶頸產能 × cycle / (3600 × stations)。"""
        if getattr(self, "_baseline_kw", None) is not None:
            return self._baseline_kw
        e = self.params["energy"]
        rate = min(len(c["stations"]) * 3600.0 / c["cycle"] for c in self.cells.values())
        total = e["base_load_kw"] + e["hvac_kw"] + e["compressed_air"]["base_kw"]
        for key in CELL_ORDER:
            c = self.cells[key]
            n = len(c["stations"])
            duty = min(1.0, rate * c["cycle"] / (3600.0 * n))
            fr = {ph: d / c["cycle"] for ph, d in
                  [(ph, sum(d2 for p2, d2 in PHASES[key] if p2 == ph))
                   for ph, _ in PHASES[key]]}
            er = e["robot"]
            wf = fr.get("WAITING_MACHINE", 0.0)
            robot = duty * (er["active"] * (1 - wf) + er["waiting"] * wf) \
                + (1 - duty) * er["idle"]
            total += n * robot
            if key == "welding":
                ew = e["welding_controller"]
                incyc = (ew["welding"] * fr.get("WELDING", 0)
                         + ew["positioning"] * (fr.get("MOVE_TO_APPROACH", 0)
                                                + fr.get("POSITIONING", 0)))
                rest = 1 - fr.get("WELDING", 0) - fr.get("MOVE_TO_APPROACH", 0) \
                    - fr.get("POSITIONING", 0)
                total += n * (duty * (incyc + ew["standby"] * rest)
                              + (1 - duty) * ew["standby"])
                # v7：壓縮機焊接負載期望值 = per_active × n × duty × fr(WELDING)
                total += e["compressed_air"]["per_active_welder_kw"] \
                    * n * duty * fr.get("WELDING", 0)
            if key == "machine_tending":
                ec = e["cnc"]
                door = fr.get("OPEN_MACHINE", 0) + fr.get("CLOSE_MACHINE", 0)
                total += n * (duty * (ec["machining"] * wf + ec["door_open"] * door
                                      + ec["idle"] * (1 - wf - door))
                              + (1 - duty) * ec["idle"])
            if key == "vision_inspection":
                ev = e["vision"]
                act = fr.get("CAPTURE_IMAGE", 0) + fr.get("INSPECTING", 0)
                total += n * (duty * (ev["active"] * act + ev["idle"] * (1 - act))
                              + (1 - duty) * ev["idle"])
        total += len(CONVEYORS) * e["conveyor"]["running"]
        il = self.params["intralogistics"]
        total += len(self.amrs) * (0.5 * il["amr_energy_kw_moving"]
                                   + 0.5 * il["amr_energy_kw_idle"])
        total += 0.15 * e["amr_charger_kw"]
        self._baseline_kw = round(total, 1)
        return self._baseline_kw

    def energy_breakdown(self) -> dict:
        """§41.3/41.4：per-asset 能源帳與 group/cell 彙總（單一來源）。"""
        rows = []
        comp = {st["robot_id"]: st["completions"]
                for k in CELL_ORDER for st in self.cells[k]["stations"]}
        comp.update({st["machine_id"]: st["completions"]
                     for st in self.cells["machine_tending"]["stations"]})
        for aid, a in self.assets.items():
            n = comp.get(aid)
            rows.append({
                "asset": aid, "group": a["group"], "cell": a["cell"],
                "kw": round(a["kw"], 2), "kwh": round(a["kwh"], 2),
                "idle_kwh": round(a["idle_kwh"], 2),
                "kwh_per_cycle": round(a["kwh"] / n, 4) if n else None,
            })
        by = {}
        for r in rows:
            g = by.setdefault(r["group"], {"kw": 0.0, "kwh": 0.0, "idle_kwh": 0.0})
            g["kw"] += r["kw"]; g["kwh"] += r["kwh"]; g["idle_kwh"] += r["idle_kwh"]
        by_cell = {}
        for r in rows:
            c = r["cell"] or ("INTRALOGISTICS" if r["group"] in ("amr", "charger")
                              else "FACILITY" if r["group"] in ("compressed_air", "hvac")
                              else "AUXILIARY")
            g = by_cell.setdefault(c, {"kw": 0.0, "kwh": 0.0})
            g["kw"] += r["kw"]; g["kwh"] += r["kwh"]
        rows.sort(key=lambda r: -r["kwh"])
        return {
            "assets": rows,
            "by_group": {g: {k2: round(v2, 2) for k2, v2 in d.items()}
                         for g, d in by.items()},
            "by_cell": {c: {k2: round(v2, 2) for k2, v2 in d.items()}
                        for c, d in by_cell.items()},
            "total_kwh": round(self.energy_kwh, 2),
            "sum_assets_kwh": round(sum(a["kwh"] for a in self.assets.values()), 2),
            "top_consumers": rows[:5],
            "top_idle_waste": sorted(rows, key=lambda r: -r["idle_kwh"])[:5],
        }

    def energy_opportunities(self) -> list[dict]:
        """§41.6：每項建議附證據、影響資產、估計節省、產能影響、信心、可逆性。"""
        out = []
        e = self.params["energy"]
        hrs = max(0.1, self.clock.sim_seconds / 3600)
        # 1) Robot auto-standby：idle/blocked 的 idle 功率 → standby
        idle_robots = [(aid, a) for aid, a in self.assets.items()
                       if a["group"] == "robot" and a["idle_kwh"] > 0.05]
        if idle_robots:
            waste = sum(a["idle_kwh"] for _, a in idle_robots)
            save = waste * (1 - e["robot"]["standby"] / e["robot"]["idle"])
            ids = [aid for aid, _ in idle_robots]
            mins = waste / e["robot"]["idle"] * 60
            out.append({
                "id": "robot_auto_standby",
                "action": "Enable robot auto-standby after "
                          f"{e['policies']['robot_standby_after_idle_sec']} s idle",
                "evidence": f"{', '.join(ids[:4])}{' and others' if len(ids) > 4 else ''} "
                            f"accumulated {mins:.0f} idle/blocked minutes consuming "
                            f"{e['robot']['idle']} kW each ({waste:.2f} kWh so far this shift).",
                "affected_assets": ids,
                "estimated_saving_kwh_shift": round(save / hrs * 8, 2),
                "estimate_note": "upper bound (all idle time); actual saving depends on "
                                 "idle episode lengths vs the standby threshold — "
                                 "verify with Energy What-if",
                "throughput_impact": "none — applies only while idle or blocked",
                "confidence": 0.7, "reversible": True, "requires_approval": True,
            })
        # 2) Conveyor stop when empty
        conv_waste = sum(self.assets[c]["idle_kwh"] for c in CONVEYORS)
        if conv_waste > 0.05:
            save = conv_waste * (1 - e["conveyor"]["stopped"] / e["conveyor"]["running"])
            out.append({
                "id": "conveyor_stop_when_starved",
                "action": "Stop conveyors while no parts are in transit",
                "evidence": f"Conveyors ran empty for "
                            f"{conv_waste / e['conveyor']['running'] * 60:.0f} minutes "
                            f"({conv_waste:.2f} kWh at {e['conveyor']['running']} kW).",
                "affected_assets": list(CONVEYORS),
                "estimated_saving_kwh_shift": round(save / hrs * 8, 2),
                "throughput_impact": "none — restart is instant in this model",
                "confidence": 0.8, "reversible": True, "requires_approval": True,
            })
        # 3) CNC standby while idle
        cnc_waste = sum(a["idle_kwh"] for aid, a in self.assets.items()
                        if a["group"] == "cnc")
        if cnc_waste > 0.05:
            save = cnc_waste * (1 - e["cnc"]["standby"] / e["cnc"]["idle"])
            out.append({
                "id": "cnc_standby",
                "action": "Put CNCs into standby while waiting for parts",
                "evidence": f"CNC-01/02 idled at {e['cnc']['idle']} kW for "
                            f"{cnc_waste / e['cnc']['idle'] * 60:.0f} minutes "
                            f"({cnc_waste:.2f} kWh).",
                "affected_assets": ["CNC-01", "CNC-02"],
                "estimated_saving_kwh_shift": round(save / hrs * 8, 2),
                "throughput_impact": "warm-up modelled as instant; real CNCs may need "
                                     "scheduling around it",
                "confidence": 0.6, "reversible": True, "requires_approval": True,
            })
        return out

    def _rework_wip(self) -> int:
        return sum(1 for pt in self.parts.values() if pt["quality"] == "REWORK_REQUIRED")

    # ------------------------------------------------------------ snapshot（ADR-005）
    def dump_state(self, hashable: bool = False) -> dict:
        d = {
            "provenance": self.provenance, "clock": self.clock.dump_state(),
            "rng": self.rng.dump_state(), "bus": self.bus.dump_state(),
            "audit": self.audit.dump_state(),
            "raw_stock": self.raw_stock, "inter": self.inter,
            "conveyors": self.conveyors, "conv_state": self.conv_state,
            "cell_states": self.cell_states,
            "rework": self.rework, "parts": self.parts,
            "cells": {k: {"stations": c["stations"]} for k, c in self.cells.items()},
            "amrs": self.amrs, "amr_queue": self.amr_queue, "task_no": self._task_no,
            "decisions": self.decisions, "decision_no": self._decision_no,
            "racks": self.racks, "supermarket": self.supermarket,
            "fg": [self.fg_picked, self.staging_units, self.outbound_total],
            "receiving": self.receiving, "outbound": self.outbound,
            "compressor_fault_until": self.compressor_fault_until,
            "obstacles": self.obstacles, "obs_no": self._obs_no,
            "fleet_kpi": self.fleet_kpi,
            "counters": {"created": self.created, "good": self.good, "scrap": self.scrap,
                         "shipped": self.shipped,
                         "fpi": self.first_pass_inspections, "fpf": self.first_pass_fails,
                         "rework_events": self.rework_events, "energy_kwh": self.energy_kwh,
                         "peak_kw": self.peak_kw, "downtime": self.downtime_sec},
            "history": self.history,
            "flow_history": self.flow_history,
            "lead_samples": self.lead_samples, "cycle_samples": self.cycle_samples,
            "buf_full_sec": self.buf_full_sec,
            "min_cell0": self._min_cell0, "min_busy0": self._min_busy0,
            "min_fleet0": self._min_fleet0,
            "assets": self.assets, "min_group0": getattr(self, "_min_group0", {}),
            "minute0": [self._min_good0, self._min_fail0, self._min_kwh0],
            "alerts": self.alerts, "alerted": sorted(self._alerted),
            "recent_inspections": self.recent_inspections,
        }
        d = json.loads(json.dumps(d))          # 深拷貝 + JSON-safe 保證
        if hashable:                            # 牆鐘欄位不參與狀態雜湊
            for ent in d["audit"]["entries"]:
                ent.pop("generated_at", None)
        return d

    def load_state(self, d: dict) -> None:
        d = json.loads(json.dumps(d))
        self.provenance = d["provenance"]
        self.run_id = self.provenance["run_id"]
        self.clock.load_state(d["clock"])
        self.rng.load_state(d["rng"])
        self.bus.load_state(d["bus"])
        self.audit.load_state(d["audit"])
        self.raw_stock = d["raw_stock"]
        self.inter = d["inter"]
        self.conveyors = d["conveyors"]
        self.conv_state = d["conv_state"]
        self.cell_states = d["cell_states"]
        self.rework = d["rework"]
        self.parts = d["parts"]
        for k, c in d["cells"].items():
            self.cells[k]["stations"] = c["stations"]
        self.amrs = d["amrs"]
        self.amr_queue = d["amr_queue"]
        self._task_no = d["task_no"]
        self.decisions = d.get("decisions", [])
        self._decision_no = d.get("decision_no", 0)
        self.racks = d["racks"]
        self.supermarket = d["supermarket"]
        self.fg_picked, self.staging_units, self.outbound_total = \
            d.get("fg", [self.shipped, 0, 0])
        self.receiving = d.get("receiving", {"stage": "IDLE", "sku": None, "qty": 0,
                                             "remaining": 0.0, "truck_no": 0})
        self.outbound = d.get("outbound", {"stage": "IDLE", "remaining": 0.0,
                                           "truck_no": 0})
        self.compressor_fault_until = d.get("compressor_fault_until", 0)
        self.obstacles = d.get("obstacles", [])
        self._obs_no = d.get("obs_no", 0)
        self.fleet_kpi = d["fleet_kpi"]
        cn = d["counters"]
        self.created, self.good, self.scrap = cn["created"], cn["good"], cn["scrap"]
        self.shipped = cn.get("shipped", 0)
        self.first_pass_inspections, self.first_pass_fails = cn["fpi"], cn["fpf"]
        self.rework_events, self.energy_kwh = cn["rework_events"], cn["energy_kwh"]
        self.peak_kw, self.downtime_sec = cn["peak_kw"], cn["downtime"]
        self.history = d["history"]
        self.flow_history = d.get("flow_history", [])
        self.lead_samples = d.get("lead_samples", [])
        self.cycle_samples = d.get("cycle_samples", {k: [] for k in CELL_ORDER})
        self.buf_full_sec = d.get("buf_full_sec", {k: 0.0 for k in self.inter})
        self._min_cell0 = d.get("min_cell0", {k: 0 for k in CELL_ORDER})
        self._min_busy0 = d.get("min_busy0", {k: 0.0 for k in CELL_ORDER})
        self._min_fleet0 = d.get("min_fleet0", 0)
        if "assets" in d:
            self.assets = d["assets"]
        self._min_group0 = d.get("min_group0", {})
        self._rebuild_asset_refs()
        self._min_good0, self._min_fail0, self._min_kwh0 = d["minute0"]
        self.alerts = d["alerts"]
        self._alerted = set(d["alerted"])
        self.recent_inspections = d.get("recent_inspections", [])

    def state_hash(self) -> str:
        return hashlib.sha256(json.dumps(self.dump_state(hashable=True),
                                         sort_keys=True).encode()).hexdigest()

    # ------------------------------------------------------------ pre-roll（§10.7）
    def preroll(self) -> None:
        n = self.params["preroll_ticks"]
        self.run_ticks(n, conservation_every=6000)
        self.check_conservation()
        self.provenance["initial_snapshot_id"] = \
            f"SNAP-PREROLL-{self.provenance['seed']}-{self.clock.tick}"

"""FactoryEngine → SnapshotMessage（wire schema，與 canonical fixture 完全相同）。

Robot 遙測（joint load／temperature）是顯示層資料，由 (seed, robot_id, tick) 的
純函數產生 — 無狀態、確定性，不影響生產邏輯與 RNG stream。
"""
from __future__ import annotations

import hashlib
import math

from twin_runtime_core.clock import wall_now_iso
from .engine import CELL_IDS, CELL_ORDER, CONVEYORS, OPERATION, FactoryEngine
from .models import SnapshotMessage

CELL_NAMES = {"welding": "Welding", "assembly": "Assembly",
              "machine_tending": "Machine Tending", "vision_inspection": "Vision Inspection"}


def _t01(seed: int, key: str, tick: int, period: int = 6000) -> float:
    """確定性 0–1 抖動：hash 相位 + 慢速正弦。"""
    h = int.from_bytes(hashlib.sha256(f"{seed}:{key}".encode()).digest()[:4], "big")
    return 0.5 + 0.5 * math.sin(2 * math.pi * ((tick / period) + h / 2**32))


def _robot_status(eng: FactoryEngine, key: str, st: dict) -> tuple[str, str, float]:
    """(status, cycle_state, progress)"""
    cyc = eng.cells[key]["cycle"]
    if st["fault_kind"] == "tool_failure":
        return "ERROR", "FAULT", min(1.0, st["elapsed"] / cyc)
    if st["fault_kind"] in ("safety_gate", "light_curtain", "e_stop", "worker_zone"):
        return "EMERGENCY_STOP", "SAFETY_STOP", min(1.0, st["elapsed"] / cyc)
    if st["fault_kind"] == "utility_air":                    # §45.8 壓縮機故障 → 焊接失氣
        return "EMERGENCY_STOP", "UTILITY_STOP", min(1.0, st["elapsed"] / cyc)
    if st["fault_kind"] is not None:
        return "MAINTENANCE", "MINOR_STOP", 0.0
    if st["part_id"] is not None:
        phase = eng._phase(key, st["elapsed"])
        prog = min(1.0, st["elapsed"] / cyc)
        if st["state"] == "BLOCKED":
            return "BLOCKED", phase, prog
        if phase == "WAITING_MACHINE":
            return "WAITING_MACHINE", phase, prog
        return "RUNNING", phase, prog
    if st["state"] == "STARVED":
        return "STARVED", "WAITING", 0.0
    return "IDLE", "WAITING", 0.0


def _buffer(eng: FactoryEngine, bid: str, occupancy: int) -> dict:
    cfg = eng.params["buffers"].get(bid, {})
    return {"buffer_id": bid, "capacity": cfg.get("capacity"),
            "occupancy": occupancy, "reorder_point": cfg.get("reorder_point")}


def _cell_state(eng: FactoryEngine, key: str) -> str:
    return eng.cell_states[key]          # 引擎推導（含 DEGRADED/FAULT），非前端計算



def _amr_status(a: dict) -> str:
    ts = a["task_state"]
    if ts in ("TRAVEL_TO_PICKUP", "DOCKING_PICKUP", "LOADING",
              "TRAVEL_TO_DROPOFF", "DOCKING_DROPOFF", "UNLOADING"):
        return "WAITING" if a["status"] == "WAITING" else "DELIVERING"
    if ts == "RETURNING":
        return "WAITING" if a["status"] == "WAITING" else "RETURNING"
    return {"CHARGING": "CHARGING", "ERROR": "ERROR"}.get(ts, "IDLE")


def _traffic_state(a: dict) -> str:
    if a.get("path_blocked"):
        return "BLOCKED"                 # §53：沒有安全路徑（原地等待、退避重試）
    if a.get("yielding"):
        return "YIELDING"
    return "REROUTED" if a.get("route_kind") == "alt" else "CLEAR"


def amr_states(eng: FactoryEngine) -> list[dict]:
    """AMR wire 區塊（snapshot 與 §50 10 Hz amr_patch 共用同一份序列化）。"""
    return [{"amr_id": a["amr_id"], "status": _amr_status(a),
             "task_state": ("WAITING_FOR_DOCK" if a["status"] == "WAITING"
                            and a["task_state"].startswith("DOCKING") else a["task_state"]),
             "battery_percent": round(a["battery"], 1),
             "current_task": a["task"]["task_id"] if a["task"] else None,
             "task_type": a["task"]["type"] if a["task"] else None,
             "task_target": a["task"]["target"] if a["task"] else None,
             "carrying": a["carrying"],
             "phase_progress": (round(1.0 - a["phase_remaining"] / a["phase_total"], 4)
                                if a["phase_total"] else 0.0),
             "phase_total_sec": a["phase_total"],
             "queue_length": len(eng.amr_queue),
             # §47：權威位置與路線；§50：位置以 10 Hz amr_patch 串流，前端只平滑不外插
             "position": [round(a["pos"][0], 2), round(a["pos"][1], 2)],
             "route": a["route"] if len(a["route"]) >= 2 else [],
             "route_progress": (round(1.0 - a["phase_remaining"] / a["phase_total"], 4)
                                if a["phase_total"] and len(a["route"]) >= 2 else 0.0),
             "traffic_state": _traffic_state(a),
             "perception": eng.perception(a),           # §51：讓行邏輯可視化
             } for a in eng.amrs]


WIRE_DECISIONS = 8                 # §51 snapshot 帶最近 N 筆派工紀錄（demo fixture 體積考量）

AMR_PATCH_FIELDS = ("position", "route_progress", "phase_progress", "status", "task_state",
                    "traffic_state", "route", "carrying", "battery_percent", "perception")


def amr_patch_message(eng: FactoryEngine, prev: dict[str, dict]) -> dict | None:
    """§50 10 Hz 增量：每台 AMR 只帶與上次送出不同的欄位（WareTwin 借鏡）；
    無任何變動 → None。prev 由呼叫端保存（per-run）。"""
    out = []
    for a in amr_states(eng):
        last = prev.get(a["amr_id"], {})
        d = {k: a[k] for k in AMR_PATCH_FIELDS if last.get(k) != a[k]}
        if d:
            d["amr_id"] = a["amr_id"]
            out.append(d)
        prev[a["amr_id"]] = a
    if not out:
        return None
    return {"type": "amr_patch", "schema_version": eng.provenance["schema_version"],
            "run_id": eng.run_id, "sim_tick": eng.clock.tick,
            "sim_time": eng.clock.sim_time_iso, "amrs": out}


def snapshot_message(eng: FactoryEngine) -> dict:
    seed, tick = eng.provenance["seed"], eng.clock.tick
    runtime = max(1e-9, min(eng.clock.sim_seconds,
                            eng.params["shift"]["length_hours"] * 3600) - eng.downtime_sec)

    # ---- utilization → bottleneck ----
    util = {k: sum(s["busy_time"] for s in eng.cells[k]["stations"])
            / (runtime * len(eng.cells[k]["stations"])) for k in CELL_ORDER}
    bottleneck = max(CELL_ORDER, key=lambda k: (util[k], k))

    cells, robots = [], []
    for key in CELL_ORDER:
        cell = eng.cells[key]
        n = len(cell["stations"])
        completions = sum(s["completions"] for s in cell["stations"])
        stations_out, active = [], 0
        for st in cell["stations"]:
            status, phase, prog = _robot_status(eng, key, st)
            if st["part_id"] is not None:
                active += 1
            stations_out.append({
                "station_id": st["station_id"], "cell_id": CELL_IDS[key],
                "state": "FAULT" if st["fault_kind"] else (
                    st["state"] if st["part_id"] is None or st["state"] == "BLOCKED"
                    else "PROCESSING"),
                "robot_id": st["robot_id"], "machine_id": st["machine_id"],
                "current_part_id": st["part_id"],
                "cycle_progress": round(prog, 3),
                "station_cycle_sec": cell["cycle"], "target_station_cycle_sec": cell["cycle"],
                "blocked_time_sec": round(st["blocked_time"], 1),
                "starved_time_sec": round(st["starved_time"], 1),
                "idle_time_sec": round(st["idle_time"], 1),
                # §45.12：維修情境動畫的權威進度（0→1）；無故障為 None/0
                "fault_kind": st["fault_kind"],
                "fault_progress": round(eng.fault_progress(st), 3) if st["fault_kind"] else 0.0,
            })
            # ---- robot（遙測為顯示層純函數） ----
            j = [_t01(seed, f"{st['robot_id']}:J{i}", tick) for i in range(6)]
            hot = 1.0 if status in ("RUNNING", "WAITING_MACHINE") else 0.4
            tool = eng._tool_health(st)
            robots.append({
                "robot_id": st["robot_id"], "line_id": "LINE-01", "cell_id": CELL_IDS[key],
                "station_id": st["station_id"],
                "process": {"welding": "spot_welding", "assembly": "precision_assembly",
                            "machine_tending": "machine_tending",
                            "vision_inspection": "quality_handling"}[key],
                "status": status, "mode": "AUTO", "cycle_state": phase,
                "cycle_progress": round(prog, 3),
                "cycle_time_sec": cell["cycle"], "target_cycle_time_sec": cell["cycle"],
                "joint_load_percent": [round(20 + 45 * x * hot) for x in j],
                "joint_temperature_c": [round(42 + 14 * x * hot, 1) for x in j],
                "tool_health_percent": round(tool, 1),
                "energy_kw": round(eng.assets[st["robot_id"]]["kw"], 1),   # §41 權威能源帳
                "alarm_code": "TOOL_FAILURE" if st["fault_kind"] == "tool_failure" else None,
                "maintenance_risk": round(min(1.0, (100 - tool) / 100 * 0.9), 2),
            })
        in_bid = "raw_material" if key == "welding" else \
            eng.inter_after[CELL_ORDER[CELL_ORDER.index(key) - 1]]
        in_occ = eng.raw_stock if key == "welding" else len(eng.inter[in_bid])
        if key == "vision_inspection":
            out = {"buffer_id": "finished_goods", "capacity": None,
                   "occupancy": eng.good - eng.fg_picked, "reorder_point": None}
        else:
            ob = eng.inter_after[key]
            out = _buffer(eng, ob, len(eng.inter[ob]))
        q_cell = 1.0 if key != "vision_inspection" else (
            (eng.first_pass_inspections - eng.first_pass_fails) / eng.first_pass_inspections
            if eng.first_pass_inspections else 1.0)
        cells.append({
            "cell_id": CELL_IDS[key], "name": CELL_NAMES[key], "state": _cell_state(eng, key),
            "operation": OPERATION[key],
            "oee": round(min(1.0, util[key]) * q_cell, 4),      # A=1（無故障）×P=util×Q
            "throughput_uph": round(completions / (runtime / 3600), 1),
            "input_buffer": _buffer(eng, in_bid, in_occ), "output_buffer": out,
            "stations": stations_out,
            "active_stations": active,
            "idle_stations": sum(1 for s in cell["stations"]
                                 if s["part_id"] is None and s["state"] != "BLOCKED"),
            "error_stations": sum(1 for s in cell["stations"] if s["fault_kind"]),
            "avg_station_cycle_sec": cell["cycle"], "is_bottleneck": key == bottleneck,
            # §46：安全條件已解除、等待操作員 Reset（前端顯示 Reset 按鈕）
            "safety_awaiting_reset": any(
                st.get("await_reset") and st["fault_kind"] in FactoryEngine.SAFETY_KINDS
                for st in cell["stations"]),
        })

    conveyors = []
    for i, cid in enumerate(CONVEYORS):
        cfg = eng.conv_cfg[cid]
        conveyors.append({
            "conveyor_id": cid, "status": eng.conv_state[cid]["status"],
            "from_cell": CELL_IDS[CELL_ORDER[i]], "to_cell": CELL_IDS[CELL_ORDER[i + 1]],
            "speed_mps": 0.5, "item_count": len(eng.conveyors[cid]),
            "in_transit_max": cfg["in_transit_max"],
            "motor_current_a": round(3 + 3 * _t01(seed, cid, tick), 1),
            "temperature_c": round(35 + 8 * _t01(seed, cid + ":t", tick), 1),
            "energy_kw": round(eng.assets[cid]["kw"], 2),
        })

    amrs = amr_states(eng)

    racks = [{"rack_id": r["rack_id"], "cell_id": CELL_IDS[key], "sku": r["sku"],
              "capacity": r["capacity"], "qty": r["qty"],
              "reorder_point": r["reorder_point"], "reserved": r["reserved"],
              "container_id": r["container_id"],
              "last_replenished_time": r["last_replenished_time"],
              "material_low": r["material_low"],
              "stockout_sec": round(r["stockout_sec"], 1)}
             for key, r in eng.racks.items()]

    k = eng.kpis()
    state = {
        "factory_id": "FACTORY-01",
        "environment": {"temperature_c": 22.4, "humidity_percent": 48,
                        "system_status": "NORMAL"},
        "line": {"line_id": "LINE-01", "name": "Robot Factory / LINE-01",
                 "state": "RUNNING", "bottleneck_cell_id": CELL_IDS[bottleneck]},
        "cells": cells, "conveyors": conveyors, "amrs": amrs, "robots": robots,
        "raw_buffer": _buffer(eng, "raw_material", eng.raw_stock),
        "rework_buffer": _buffer(eng, "rework_area", len(eng.rework)),
        "finished_buffer": {"buffer_id": "finished_goods", "capacity": None,
                            "occupancy": eng.good - eng.fg_picked, "reorder_point": None},
        "parts": {"created": eng.created, "wip": eng.wip(), "good_completed": eng.good,
                  "scrap": eng.scrap, "shipped": eng.shipped,
                  "held": sum(1 for p in eng.parts.values() if p["lifecycle"] == "HELD"),
                  "rework_wip": eng._rework_wip()},
        "racks": racks,
        "supermarket": {
            "per_sku": [{"sku": sku, "qty": q,
                         "capacity": eng.supermarket["capacity_per_sku"]}
                        for sku, q in eng.supermarket["per_sku"].items()],
            "empties": eng.supermarket["empties"]},
        "staging": {"units": eng.staging_units,
                    "pallet_size": eng.params["intralogistics"]["staging"]["pallet_size"],
                    "pallets_per_truck":
                        eng.params["intralogistics"]["staging"]["pallets_per_truck"],
                    "outbound_total": eng.outbound_total,
                    # §45.4 出貨事件鏈（門動畫與出貨標示的權威來源）
                    "outbound_stage": eng.outbound["stage"],
                    "door_open": eng.outbound["stage"] == "DOCKED",
                    # DOCKED 裝車進度 0→1（棧板移入車尾動畫的權威來源）
                    "outbound_progress": (round(1.0 - eng.outbound["remaining"]
                        / max(1e-9, eng.params["intralogistics"]["staging"]["outbound_load_sec"]), 3)
                        if eng.outbound["stage"] == "DOCKED" else 0.0),
                    "shipment_id": (f"TRUCK-{eng.outbound['truck_no']:03d}"
                                    if eng.outbound["stage"] != "IDLE" else None)},
        # §45.8 廠務設備狀態（狀態燈／tooltip／能耗；壓縮機故障=焊接失氣）
        "facility": eng.facility(),
        # §48 空間障礙物（有座標；AMR 規劃繞開）
        "obstacles": [{"obstacle_id": ob["obstacle_id"],
                       "position": [round(ob["x"], 2), round(ob["z"], 2)],
                       "radius_m": ob["radius"],
                       "clearance_m": round(ob["radius"]
                                            + eng.params["intralogistics"]["traffic"]["hard_stop_m"], 2),
                       "label": ob["label"],
                       "remaining_sec": round(max(0.0, (ob["until"] - tick) * eng.clock.dt), 1)}
                      for ob in eng.obstacles],
        # §45.3 收貨事件鏈（捲門／待驗區／已驗區的權威來源）
        "receiving": {"stage": eng.receiving["stage"], "sku": eng.receiving["sku"],
                      "qty": eng.receiving["qty"],
                      "door_open": eng.receiving["stage"] in ("DOOR_OPENING", "UNLOADING"),
                      "truck_id": (f"IN-{eng.receiving['truck_no']:03d}"
                                   if eng.receiving["stage"] != "IDLE" else None)},
        "dispatch_decisions": eng.decisions[-WIRE_DECISIONS:],   # §51（引擎環 20；wire 最近 8）
        "amr_kpis": eng.amr_kpis(),
        "orders": [{
            "order_id": "PO-2026-0822-001", "line_id": "LINE-01", "product_id": "PRODUCT-A",
            "target_quantity": eng.params["target_good_units_per_shift"],
            "completed_quantity": eng.good, "defect_quantity": eng.first_pass_fails,
            "priority": "HIGH", "status": "IN_PROGRESS",
            "planned_start": "2026-08-22T06:00:00+08:00",
            "planned_end": "2026-08-22T14:00:00+08:00"}],
        "kpis": k,
        "history_minutes": eng.history[-240:],
        "recent_events": eng.bus.recent(8),
        "alerts": sorted(eng.alerts, key=lambda a: (a["resolved"], -a["event_seq"]))[:12],
        "simulated_history": True,
    }
    msg = {
        "type": "snapshot", "schema_version": eng.provenance["schema_version"],
        "run_id": eng.run_id, "seq": eng.bus.seq, "sim_tick": eng.clock.tick,
        "sim_time": eng.clock.sim_time_iso, "generated_at": wall_now_iso(),
        "provenance": eng.provenance, "state": state,
    }
    SnapshotMessage.model_validate(msg)
    return msg

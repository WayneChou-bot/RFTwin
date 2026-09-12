"""What-if Simulation（§23、ADR-005）。

從 Live snapshot（tick T）建立兩個隔離的 in-process Engine：
BASELINE（無注入）與 SCENARIO（注入故障）。兩者複製完整狀態——
Twin State、Clock、Event buffer、**PRNG internal state**、Buffer、進行中
cycle、KPI accumulator——唯一差異是注入。Live Engine 絕不被修改。
"""
from __future__ import annotations

import json

from .engine import FactoryEngine

DELTA_KEYS = [
    "total_output", "good_units", "defect_units", "throughput_uph",
    "oee", "availability", "performance", "quality",
    "wip", "downtime_sec", "energy_kwh_total", "energy_kwh_per_unit",
]

_counter = {"n": 0}

# §50（WareTwin 借鏡）：統一 12 項對照指標（key, 標籤, 越高越好?）
METRICS = [
    ("good_units", "Good units", True),
    ("throughput_uph", "Throughput (units/h)", True),
    ("oee", "OEE", True),
    ("availability", "Availability", True),
    ("quality", "Quality (FPY)", True),
    ("wip", "WIP at end", False),
    ("downtime_sec", "Downtime (s)", False),
    ("blocked_time_sec", "Station blocked time (s)", False),
    ("amr_tasks_completed", "AMR tasks completed", True),
    ("amr_stockout_min", "Material stockout (min)", False),
    ("energy_kwh_total", "Energy (kWh)", False),
    ("energy_kwh_per_unit", "Energy per unit (kWh)", False),
]


def _metric_values(eng: FactoryEngine, flat: dict) -> dict:
    k = eng.amr_kpis()
    out = {key: flat[key] for key in ("good_units", "throughput_uph", "oee", "availability",
                                       "quality", "wip", "downtime_sec",
                                       "energy_kwh_total", "energy_kwh_per_unit")}
    out["blocked_time_sec"] = round(sum(s["blocked_time"] for c in eng.cells.values()
                                        for s in c["stations"]), 1)
    out["amr_tasks_completed"] = k["tasks_completed"]
    out["amr_stockout_min"] = k["stockout_min"]
    return out


def metrics_table(base: dict, scen: dict) -> list[dict]:
    rows = []
    for key, label, hib in METRICS:
        b, s = base[key], scen[key]
        d = round(s - b, 4)
        pct = round(d / b * 100, 1) if b else None
        better = None if d == 0 else (d > 0) == hib
        rows.append({"key": key, "label": label, "higher_is_better": hib,
                     "baseline": b, "scenario": s, "delta": d, "delta_pct": pct,
                     "better": better})
    return rows


def first_divergence(baseline: FactoryEngine, scenario: FactoryEngine,
                     after_seq: int, skip_seq: int | None = None) -> dict | None:
    """§50：兩條事件流（branch 之後）逐筆對比，回傳第一個分岔（同 seed + 同注入序列
    = 決定性重播，因此分岔只可能來自注入本身及其後果）。skip_seq = 注入事件本身
    （已知的第一個差異，略過以指出「第一個後果」）。"""
    def stream(eng: FactoryEngine) -> list[dict]:
        return [ev for ev in eng.bus.dump_state()["buffer"] if ev["seq"] > after_seq
                and ev["seq"] != skip_seq]
    b, s = stream(baseline), stream(scenario)
    for i in range(max(len(b), len(s))):
        eb = b[i] if i < len(b) else None
        es = s[i] if i < len(s) else None
        kb = (eb["event_type"], eb["source_id"]) if eb else None
        ks = (es["event_type"], es["source_id"]) if es else None
        if kb != ks:
            ev = es or eb
            return {"index": i, "sim_tick": ev["sim_tick"], "sim_time": ev["sim_time"],
                    "baseline_event": (f"{eb['event_type']} {eb['source_id']}" if eb else None),
                    "scenario_event": (f"{es['event_type']} {es['source_id']}" if es else None),
                    "message": (es or eb)["message"]}
    return None


def _flat(k: dict) -> dict:
    out = {key: k[key] for key in k if not isinstance(k[key], dict)}
    out.update({key: k["oee"][key] for key in ("oee", "availability", "performance", "quality")})
    return out


def _branch(state: dict, run_id: str, branch_from: dict, params: dict) -> FactoryEngine:
    eng = FactoryEngine(run_id=run_id, seed=state["provenance"]["seed"], params=params)
    eng.load_state(json.loads(json.dumps(state)))     # 隔離：深拷貝
    eng.provenance = dict(eng.provenance)
    eng.provenance.update({"run_id": run_id, "branch_from": branch_from})
    eng.run_id = run_id
    eng.bus.run_id = run_id                            # 各自的 run/seq 空間（延續 seq）
    eng.audit.run_id = run_id
    return eng


# What-if 的語意邊界（引擎層強制，前端 min/max 不算保護）。
WHATIF_LIMITS = {"duration_min_sec": 10.0, "duration_max_sec": 7200.0,
                 "horizon_min_min": 5, "horizon_max_min": 240}


def validate_whatif(duration_sec: float | None, horizon_min: int) -> tuple[float | None, int]:
    """回傳正規化後的 (duration_sec, horizon_min)；越界 → ValueError（API 轉 422）。
    horizon 5–240 min（240 min ≈ 144k tick × 2 引擎，是公開服務可接受的單次上限）；
    duration 10 s–2 h（負值／0 會產生「repair takes -5s」這種無意義解釋）。"""
    L = WHATIF_LIMITS
    try:
        horizon_min = int(horizon_min)
    except (TypeError, ValueError):
        raise ValueError(f"horizon_min must be an integer ({L['horizon_min_min']}–{L['horizon_max_min']})")
    if not L["horizon_min_min"] <= horizon_min <= L["horizon_max_min"]:
        raise ValueError(f"horizon_min {horizon_min} out of range "
                         f"{L['horizon_min_min']}–{L['horizon_max_min']} min")
    if duration_sec is not None:
        try:
            duration_sec = float(duration_sec)
        except (TypeError, ValueError):
            raise ValueError("duration_sec must be a number")
        if not (duration_sec == duration_sec) or \
                not L["duration_min_sec"] <= duration_sec <= L["duration_max_sec"]:
            raise ValueError(f"duration_sec {duration_sec} out of range "
                             f"{L['duration_min_sec']:.0f}–{L['duration_max_sec']:.0f} s")
    return duration_sec, horizon_min


def run_scenario(live: FactoryEngine | None, *, failure_type: str, target_id: str,
                 duration_sec: float, horizon_min: int = 30,
                 state: dict | None = None, params: dict | None = None) -> dict:
    """同步跑完 BASELINE 與 SCENARIO，回傳比較結果。Live 不受影響。
    可傳入預先 dump 的 state（API 層在 lock 內複製、於 thread 執行，避免凍住
    event loop —— review P1-3）；否則自行 dump live。"""
    duration_sec, horizon_min = validate_whatif(duration_sec, horizon_min)
    if state is None:
        assert live is not None
        state = live.dump_state()                      # 唯一一次讀取 Live；之後不再觸碰
    if params is None:
        assert live is not None
        params = live.params
    _counter["n"] += 1
    n = _counter["n"]
    branch_from = {"run_id": state["provenance"]["run_id"], "seq": state["bus"]["seq"]}

    baseline = _branch(state, f"BASELINE-{n:03d}", branch_from, params)
    scenario = _branch(state, f"SCENARIO-{n:03d}", branch_from, params)
    injection_ev = scenario.inject(failure_type, target_id, duration_sec)

    ticks = int(horizon_min * 60 / (params["tick_ms"] / 1000.0))
    baseline.run_ticks(ticks)
    scenario.run_ticks(ticks)
    baseline.check_conservation()
    scenario.check_conservation()

    kb, ks = _flat(baseline.kpis()), _flat(scenario.kpis())
    deltas = {key: round(ks[key] - kb[key], 4) for key in DELTA_KEYS}
    mb, ms = _metric_values(baseline, kb), _metric_values(scenario, ks)

    # 場景側的補充證據（給 explanation 用）
    def blocked_sum(eng: FactoryEngine) -> float:
        return sum(s["blocked_time"] for c in eng.cells.values() for s in c["stations"])

    return {
        "scenario_id": f"SC-{n:03d}",
        "injection": {"failure_type": failure_type, "target_id": target_id,
                      "duration_sec": duration_sec},
        "horizon_min": horizon_min,
        "branch_from": branch_from,
        "baseline": {"run_id": baseline.run_id, "kpis": kb,
                     "provenance": baseline.provenance},
        "scenario": {"run_id": scenario.run_id, "kpis": ks,
                     "provenance": scenario.provenance},
        "deltas": deltas,
        # §50：12 項統一對照表（方向、±、±%）＋事件流第一分岔（略過注入事件本身）
        "metrics": metrics_table(mb, ms),
        "first_divergence": first_divergence(baseline, scenario, branch_from["seq"],
                                             skip_seq=injection_ev["seq"]),
        "evidence_raw": {
            "blocked_time_delta_sec": round(blocked_sum(scenario) - blocked_sum(baseline), 1),
            "downtime_delta_sec": round(ks["downtime_sec"] - kb["downtime_sec"], 1),
            "good_delta": int(ks["good_units"] - kb["good_units"]),
            "scenario_events": sum(1 for ev in scenario.bus.dump_state()["buffer"]
                                   if ev["seq"] > branch_from["seq"]
                                   and ev["event_type"] in
                                   ("STATION_BLOCKED", "CELL_BLOCKED", "CELL_STARVED")),
            "injection_seq": injection_ev["seq"],
        },
    }


# ---------------------------------------------------------------- §41.7 Energy What-if

ENERGY_POLICIES = {
    "robot_auto_standby": "Robot auto-standby after idle threshold",
    "conveyor_stop_when_starved": "Stop conveyors while empty",
    "cnc_standby": "CNC standby while waiting for parts",
}


def run_energy_scenario(live: FactoryEngine | None, *, policies: list[str],
                        horizon_min: int = 30,
                        state: dict | None = None, params: dict | None = None) -> dict:
    """§41.7：BASELINE（現行策略）vs POLICY（套用節能政策）。
    政策只作用於功率模型，不改變生產邏輯；兩引擎其他狀態完全相同，
    因此 Δthroughput/ΔOEE 應為 0 —— 表格同時列出以資證明「節能未犧牲產能」。"""
    bad = [p for p in policies if p not in ENERGY_POLICIES]
    if bad:
        raise ValueError(f"unknown energy policies: {bad}")
    _, horizon_min = validate_whatif(None, horizon_min)
    if state is None:
        assert live is not None
        state = live.dump_state()
    if params is None:
        assert live is not None
        params = live.params
    _counter["n"] += 1
    n = _counter["n"]
    branch_from = {"run_id": state["provenance"]["run_id"], "seq": state["bus"]["seq"]}
    base = _branch(state, f"EBASE-{n:03d}", branch_from, params)
    pol = _branch(state, f"EPOLICY-{n:03d}", branch_from, params)
    pol.energy_policy = set(policies)
    ticks = int(horizon_min * 60 / (params["tick_ms"] / 1000.0))
    e0b, e0p = base.energy_kwh, pol.energy_kwh
    pk0b, pk0p = base.peak_kw, pol.peak_kw
    base.peak_kw = pol.peak_kw = 0.0            # 觀測 horizon 內的峰值
    base.run_ticks(ticks)
    pol.run_ticks(ticks)
    base.check_conservation()
    pol.check_conservation()
    kb, kp = _flat(base.kpis()), _flat(pol.kpis())
    horizon_kwh_base = round(base.energy_kwh - e0b, 2)
    horizon_kwh_pol = round(pol.energy_kwh - e0p, 2)
    res = {
        "scenario_id": f"EN-{n:03d}", "policies": policies,
        "policy_labels": [ENERGY_POLICIES[p] for p in policies],
        "horizon_min": horizon_min, "branch_from": branch_from,
        "baseline": {"energy_kwh": horizon_kwh_base, "peak_kw": round(base.peak_kw, 1),
                     "good_units": kb["good_units"], "oee": kb["oee"],
                     "throughput_uph": kb["throughput_uph"],
                     "units_per_kwh": (round(kb["good_units"] / horizon_kwh_base, 2)
                                       if horizon_kwh_base else 0.0)},
        "policy": {"energy_kwh": horizon_kwh_pol, "peak_kw": round(pol.peak_kw, 1),
                   "good_units": kp["good_units"], "oee": kp["oee"],
                   "throughput_uph": kp["throughput_uph"],
                   "units_per_kwh": (round(kp["good_units"] / horizon_kwh_pol, 2)
                                     if horizon_kwh_pol else 0.0)},
        "deltas": {
            "energy_kwh": round(horizon_kwh_pol - horizon_kwh_base, 2),
            "energy_pct": (round((horizon_kwh_pol - horizon_kwh_base)
                                 / horizon_kwh_base * 100, 1) if horizon_kwh_base else 0.0),
            "peak_kw": round(pol.peak_kw - base.peak_kw, 1),
            "good_units": kp["good_units"] - kb["good_units"],
            "oee": round(kp["oee"] - kb["oee"], 4),
        },
        "note": "Policies act on the power model only; production logic is identical "
                "in both branches (isolated engines; live run untouched).",
    }
    base.peak_kw, pol.peak_kw = pk0b, pk0p
    return res

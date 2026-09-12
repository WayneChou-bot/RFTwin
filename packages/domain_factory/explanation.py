"""規則式 Root-Cause Explanation（§22）。

證據全部取自真實事件與 KPI，禁止把推測描述成事實（§22.3）；每個回答都是
§22.2 的結構化 JSON，並標示 Evidence／Confidence／Assumptions／Risk／
Human approval。自然語言層（Ollama）只負責把這份 JSON 轉成文字，不新增事實。
"""
from __future__ import annotations

from .engine import FactoryEngine

_ACTIONS = {
    "conveyor_jam": [
        "Dispatch maintenance to clear the jammed conveyor",
        "Temporarily stage completed parts at the upstream cell",
        "Re-check conveyor motor current after restart",
    ],
    "tool_failure": [
        "Replace or inspect the failed tool before restart",
        "Route the held part to rework after repair",
        "Rebalance dispatch to the remaining stations in the cell",
    ],
    "minor_stop": [
        "Review minor-stop frequency for the affected station",
        "Schedule preventive check at next changeover",
    ],
}


def _base(summary: str, cause: str, evidence: list[str], actions: list[str],
          confidence: float, assumptions: list[str], impact: str, risk: str) -> dict:
    return {
        "summary": summary,
        "primary_cause": cause,
        "evidence": evidence,
        "recommended_actions": actions,
        "confidence": round(max(0.0, min(1.0, confidence)), 2),
        "assumptions": assumptions,
        "expected_impact": impact,
        "risk": risk,
        "requires_human_approval": True,
        "is_simulation_result": True,
    }


def explain_scenario(result: dict) -> dict:
    """What-if 比較的解釋：證據直接引用兩個 run 的差異數字。"""
    inj = result["injection"]
    d = result["deltas"]
    raw = result["evidence_raw"]
    good_delta = d["good_units"]
    oee_pp = d["oee"] * 100
    absorbed = abs(good_delta) < 3
    if absorbed:
        summary = (f"{inj['target_id']} {inj['failure_type']} for {inj['duration_sec']:.0f}s "
                   f"has no material production impact over {result['horizon_min']} min: "
                   f"the cell's remaining parallel stations absorb the loss and the "
                   f"bottleneck is unaffected (Δgood {good_delta:+.0f}, ΔOEE {oee_pp:+.1f} pp).")
    else:
        summary = (f"{inj['target_id']} {inj['failure_type']} for "
                   f"{inj['duration_sec']:.0f}s over a {result['horizon_min']}-min horizon "
                   f"costs {abs(good_delta):.0f} good units and {oee_pp:+.1f} pp OEE "
                   f"versus baseline.")
    cause = {
        "conveyor_jam": f"Injected jam on {inj['target_id']} starved the downstream cell "
                        f"and back-pressured the whole line.",
        "tool_failure": f"Tool failure on {inj['target_id']} removed one parallel station; "
                        f"the in-progress part was held and later reworked.",
        "minor_stop": f"Injected minor stop on {inj['target_id']}.",
    }.get(inj["failure_type"], inj["failure_type"])
    evidence = [
        f"Good units: {result['scenario']['kpis']['good_units']} (scenario) vs "
        f"{result['baseline']['kpis']['good_units']} (baseline), Δ {good_delta:+.0f}",
        f"OEE: {result['scenario']['kpis']['oee']:.4f} vs "
        f"{result['baseline']['kpis']['oee']:.4f}, Δ {d['oee']:+.4f}",
        f"Throughput: Δ {d['throughput_uph']:+.1f} u/h",
        f"Station blocked time Δ {raw['blocked_time_delta_sec']:+.1f} s across the line",
        f"{raw['scenario_events']} blocked/starved events after branch "
        f"(injection at seq {raw['injection_seq']})",
    ]
    if abs(d["downtime_sec"]) > 0.5:
        evidence.append(f"Bottleneck downtime Δ {d['downtime_sec']:+.1f} s")
    conf = 0.9 if not absorbed else 0.85             # 「被冗餘吸收」本身是高信心結論
    actions = (["No immediate production action needed — schedule repair without "
                "slowing the line", "Monitor the cell for a second failure "
                "(capacity margin is now reduced)"] if absorbed
               else _ACTIONS.get(inj["failure_type"], []))
    return _base(
        summary, cause, evidence, actions,
        conf,
        [
            f"Deterministic simulation, seed {result['baseline']['provenance']['seed']}, "
            f"branch at seq {result['branch_from']['seq']}",
            f"Parameter set {result['baseline']['provenance']['parameter_set_id']} "
            f"({result['baseline']['provenance']['parameter_hash'][:18]}…)",
            "Baseline and scenario share identical RNG state at branch point",
        ],
        f"≈ {abs(good_delta):.0f} good units over {result['horizon_min']} min if the "
        f"failure occurs and repair takes {inj['duration_sec']:.0f}s",
        "Simulation result — real-world repair time and operator response may differ",
    )


def explain_live(eng: FactoryEngine) -> dict:
    """Live 狀態的解釋：從未解決 Alert 與近期事件取證據。"""
    active = [a for a in eng.alerts if not a["resolved"]]
    k = eng.kpis()
    if not active:
        return _base(
            f"No active anomaly. OEE {k['oee']['oee']:.1%}, "
            f"throughput {k['throughput_uph']} u/h, on pace for "
            f"{k['target_good_units']} target." if k["throughput_uph"] else "Line idle.",
            "Normal operation",
            [f"0 unresolved alerts; {k['defect_units']} fails in "
             f"{k['total_output']} units (FPY {k['first_pass_yield']:.2%})",
             f"Availability {k['oee']['availability']:.2%} "
             f"(bottleneck downtime {k['downtime_sec']:.0f}s)"],
            ["No action required"], 0.8,
            ["Rule-based analysis of live twin state"],
            "None", "None",
        )
    a = active[0]                                     # 最嚴重的（列表已排序）
    recent = [ev for ev in eng.bus.dump_state()["buffer"][-200:]
              if ev["event_type"] in ("STATION_BLOCKED", "CELL_BLOCKED", "CELL_STARVED",
                                      "CONVEYOR_JAMMED", "TOOL_FAILURE")]
    evidence = [f"Alert {a['alert_id']} [{a['severity']}] {a['title']} at "
                f"{a['sim_time'][11:19]} (event seq {a['event_seq']})"]
    evidence += [f"{ev['sim_time'][11:19]} {ev['source_id']} {ev['event_type']}"
                 for ev in recent[-4:]]
    kind = "conveyor_jam" if a["source_type"] == "CONVEYOR" else \
        "tool_failure" if "Tool" in a["title"] else "minor_stop"
    return _base(
        f"{a['title']}: {len(recent)} blocked/starved/fault events in recent window; "
        f"OEE {k['oee']['oee']:.1%}.",
        a["detail"], evidence, _ACTIONS.get(kind, []), 0.85,
        ["Rule-based causal trace over the event log; no data fabricated"],
        "Throughput reduced while the fault persists",
        "If unresolved, downstream starvation will continue",
    )

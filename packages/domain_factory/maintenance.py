"""基礎 Predictive Maintenance（§17：threshold + trend）。

模型只用真實引擎資料：tool_health（隨 completions 線性磨耗）與完工速率。
RUL 為線性外插至維護門檻；依 §17.2，輸出必須含造成風險的訊號與模擬標記。
"""
from __future__ import annotations

from .engine import CELL_ORDER, FactoryEngine

HEALTH_MAINT_THRESHOLD = 60.0
WEAR_PER_COMPLETION = 0.02          # 與 engine._tool_health 一致


def assess(eng: FactoryEngine) -> list[dict]:
    out = []
    shift_sec = eng.params["shift"]["length_hours"] * 3600
    elapsed = max(60.0, eng.clock.sim_seconds)
    for key in CELL_ORDER:
        for st in eng.cells[key]["stations"]:
            health = eng._tool_health(st)
            rate_per_shift = st["completions"] / elapsed * shift_sec
            wear_per_shift = rate_per_shift * WEAR_PER_COMPLETION
            rul_shifts = ((health - HEALTH_MAINT_THRESHOLD) / wear_per_shift
                          if wear_per_shift > 0 else None)
            risk = round(min(1.0, max(0.0, (100 - health) / 40)), 2)
            out.append({
                "robot_id": st["robot_id"],
                "station_id": st["station_id"],
                "health_score": round(health, 1),
                "completions": st["completions"],
                "wear_per_shift": round(wear_per_shift, 2),
                "rul_shifts": round(rul_shifts, 1) if rul_shifts is not None else None,
                "maintenance_risk": risk,
                "recommended_window": (
                    "next changeover" if rul_shifts is not None and rul_shifts < 2
                    else "within this week" if rul_shifts is not None and rul_shifts < 10
                    else "routine"),
                "top_signals": [
                    {"signal": "tool_wear",
                     "value": round(100 - health, 1),
                     "baseline": 0.0,
                     "note": f"{st['completions']} completions × "
                             f"{WEAR_PER_COMPLETION}/cycle"},
                    {"signal": "fault_time_sec",
                     "value": round(st["fault_time"], 1),
                     "baseline": 0.0,
                     "note": "accumulated minor stops / failures"},
                ],
                "method": "linear wear model + threshold (V1)",
                "is_simulation_result": True,
            })
    out.sort(key=lambda r: r["maintenance_risk"], reverse=True)
    return out

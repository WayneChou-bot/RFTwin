"""§47 AMR 交通管理：空間間距、讓行／改道／續行、路線連續性、決定性。"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages"))

from domain_factory.engine import AMR_HOME, FactoryEngine  # noqa: E402
from domain_factory.serialize import snapshot_message  # noqa: E402


def _pair_dist(e: FactoryEngine) -> float:
    a1, a2 = e.amrs
    return math.hypot(a1["pos"][0] - a2["pos"][0], a1["pos"][1] - a2["pos"][1])


def test_min_separation_2h():
    """§47.4：兩車中心距永不低於 hard_stop（移動鉗制的絕對保證）。"""
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    hs = e.params["intralogistics"]["traffic"]["hard_stop_m"]
    mind = 9e9
    for i in range(72000):          # 2 小時
        e.step()
        if i % 5 == 0:
            mind = min(mind, _pair_dist(e))
    assert mind >= hs - 1e-6, f"min separation {mind:.2f} < hard_stop {hs}"


def test_amr_sensor_stop_is_causal():
    """§46/§48：amr_obstacle = 該車感測器停車（語意誠實）。因果驗證：
    停車期間該車位置不變；期間若他車讓行，AMR_YIELD 必指名被停的車；
    解除（OBSTACLE_CLEARED）後該車恢復移動；全程間距不低於 hard_stop。"""
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    # 等到 AMR-01 正在行走再停它（否則「停車」無可觀測差異）
    for _ in range(72000):
        e.step()
        if e.amrs[0]["task"] and e.amrs[0]["task_state"].startswith("TRAVEL"):
            break
    a = e.amrs[0]
    before = e.bus.seq
    ev = e.inject("amr_obstacle", "AMR-01", 60)
    t_start, t_end = ev["sim_tick"], ev["sim_tick"] + 600
    frozen = list(a["pos"])
    mind = 9e9
    while e.clock.tick < t_end:
        e.step()
        assert a["pos"] == frozen, "sensor-stopped AMR must not move"
        mind = min(mind, _pair_dist(e))
    for _ in range(600):
        e.step()
        mind = min(mind, _pair_dist(e))
    evs = e.bus.after(before)[0]
    types = [x["event_type"] for x in evs]
    assert "AMR_OBSTACLE" in types and "OBSTACLE_CLEARED" in types
    cleared = next(x for x in evs if x["event_type"] == "OBSTACLE_CLEARED")
    assert cleared["source_id"] == "AMR-01" and cleared["sim_tick"] >= t_end - 5
    # 期間內的讓行必須是「讓給 AMR-01」（因果綁定；自然交通不得混入）
    for x in evs:
        if x["event_type"] == "AMR_YIELD" and t_start <= x["sim_tick"] <= t_end:
            assert "AMR-01" in x["message"], x["message"]
    assert a["pos"] != frozen or a["task"] is None, "AMR-01 should resume after clear"
    hs = e.params["intralogistics"]["traffic"]["hard_stop_m"]
    assert mind >= hs - 1e-6


def test_zone_obstacle_causal_detour():
    """§48：空間障礙物（有座標）→ 路線規劃真正繞開：
    (1) 期間內任何 AMR 與障礙中心距離 ≥ radius + 0.5（移動鉗制）；
    (2) 期間內規劃的每條路線離障礙 ≥ radius + hard_stop − 容差；
    (3) AMR_DETOUR／AMR_REROUTED 事件指名該 OBS id 且落在期間內；
    (4) 到期 OBSTACLE_REMOVED。"""
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    before = e.bus.seq
    ev = e.inject("zone_obstacle", "corridor_west", 90)
    ob = e.obstacles[0]
    t0, t1 = ev["sim_tick"], ev["sim_tick"] + 900
    tr = e.params["intralogistics"]["traffic"]
    seen_routes: set[tuple] = set()
    mind = 9e9
    while e.clock.tick <= t1 + 5:
        e.step()
        for a in e.amrs:
            if e.obstacles:
                mind = min(mind, math.hypot(a["pos"][0] - ob["x"], a["pos"][1] - ob["z"]))
                r = a["route"]
                if len(r) >= 2 and tuple(map(tuple, r)) not in seen_routes:
                    seen_routes.add(tuple(map(tuple, r)))
                    lim = ob["radius"] + tr["hard_stop_m"] - 0.06
                    for i in range(len(r) - 1):
                        d = FactoryEngine._seg_point_dist(r[i], r[i + 1], [ob["x"], ob["z"]])
                        assert d >= lim, f"route passes {d:.2f} m from {ob['obstacle_id']}"
    assert mind >= ob["radius"] + 0.5 - 1e-6
    evs = e.bus.after(before)[0]
    related = [x for x in evs if x["event_type"] in ("AMR_DETOUR", "AMR_REROUTED")
               and ob["obstacle_id"] in x["message"] and t0 <= x["sim_tick"] <= t1]
    assert related, "no causal detour/reroute naming the obstacle during its window"
    assert any(x["event_type"] == "OBSTACLE_REMOVED" and x["source_id"] == ob["obstacle_id"]
               for x in evs)
    assert not e.obstacles


def test_reroute_restores_moving_status():
    """改道後 status 必須回到 DELIVERING／RETURNING（不得停在 WAITING）。
    (a) 障礙放在行走中 AMR 的路線上 → 立即改道 → 狀態為行進；
    (b) 1h 不變式：行走中且非讓行、非感測器停車 → status ≠ WAITING。"""
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    for _ in range(72000):
        e.step()
        cand = [a for a in e.amrs if a["task_state"].startswith("TRAVEL")
                and len(a["route"]) >= 4 and a["phase_remaining"] / a["phase_total"] > 0.6]
        if cand:
            break
    a = cand[0]
    seg_mid = a["route"][-3]
    before = e.bus.seq
    e.inject("zone_obstacle", "custom", 60, extra={"x": seg_mid[0], "z": seg_mid[1]})
    evs = e.bus.after(before)[0]
    msgs = [x["message"] for x in evs if x["event_type"] == "AMR_REROUTED"]
    if a.get("path_blocked"):
        # §53：障礙落在 dock 進場支線上時沒有任何候選能繞開 → 誠實地 BLOCKED，不宣稱改道
        assert not msgs, "must not claim a reroute when no safe path exists"
        assert a["status"] == "WAITING"
    else:
        assert any(a["amr_id"] in m and "on planned route" in m for m in msgs)
        assert a["status"] in ("DELIVERING", "RETURNING") and not a["yielding"]
    for _ in range(36000):
        e.step()
        for x in e.amrs:
            traveling = x["task_state"].startswith("TRAVEL") or x["task_state"] == "RETURNING"
            if traveling and not x["yielding"] and x.get("obstacle_until", 0) <= e.clock.tick \
                    and not x.get("path_blocked"):
                assert x["status"] != "WAITING", f"{x['amr_id']} moving but WAITING"


def test_drop_f_matches_selected_route():
    """空箱卸回點 drop_f 必須依「選中」路線計算（Supermarket 點的
    弧長比例），否則 payload 會在錯的位置消失。"""
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    checked = 0
    for _ in range(36000):
        e.step()
        for a in e.amrs:
            if a["task_state"] == "RETURNING" and a["carrying"] == "empty" and a["drop_f"]:
                r = a["route"]
                lens = FactoryEngine._seg_lens(r)
                total = sum(lens)
                acc, expect = 0.0, 0.0
                for i, seg in enumerate(lens):
                    acc += seg
                    if abs(r[i + 1][0] + 44.0) < 0.1 and abs(r[i + 1][1] - 21.5) < 0.1:
                        expect = acc / total
                        break
                assert abs(a["drop_f"] - expect) < 1e-9
                checked += 1
    assert checked > 0


def test_faulted_amr_not_a_permanent_roadblock():
    """§47.3：單車故障停在路上 → 另一車以候選路線評分繞開，補料不斷料。"""
    e = FactoryEngine()
    e.run_ticks(36000)
    e.inject("amr_fault", "AMR-02", 900)
    e.run_ticks(18000)
    k = e.amr_kpis()
    assert k["stockout_min"] == 0.0
    assert k["on_time_replenishment_pct"] == 100.0


def test_routes_start_at_current_position():
    """§47.2：每次路線「切換」的當下，新路線第一點 = 該 tick 的實際位置
    （逐 tick 偵測路線物件變更；容差 = 座標四捨五入 0.01）——瞬移在來源上不可能。
    另驗：位置每 0.5 s 移動 ≤ 車速 × 0.5 s（+ 反向避讓一步）。"""
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    last_route = {a["amr_id"]: a["route"] for a in e.amrs}
    last_pos = {a["amr_id"]: list(a["pos"]) for a in e.amrs}
    speed = e.params["intralogistics"]["fleet"]["speed_m_per_s"]
    switches = 0
    for _ in range(36000):
        e.step()
        for a in e.amrs:
            if a["route"] is not last_route[a["amr_id"]]:
                last_route[a["amr_id"]] = a["route"]
                if len(a["route"]) >= 2:
                    switches += 1
                    d = math.hypot(a["route"][0][0] - a["pos"][0],
                                   a["route"][0][1] - a["pos"][1])
                    # 路線起點 = 建線當下位置；本 tick 最多再前進一步（0.6 m）
                    assert d <= speed * 0.5 + 0.02, f"{a['amr_id']} route[0] {d:.2f} m from pos"
            step = math.hypot(a["pos"][0] - last_pos[a["amr_id"]][0],
                              a["pos"][1] - last_pos[a["amr_id"]][1])
            assert step <= speed * 0.5 + 0.02, f"{a['amr_id']} jumped {step:.2f} m in one tick"
            last_pos[a["amr_id"]] = list(a["pos"])
    assert switches > 10


def test_wire_has_route_and_traffic_state():
    """§47.6：wire 含 position／route／route_progress／traffic_state。"""
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    m = snapshot_message(e)
    for a in m["state"]["amrs"]:
        assert len(a["position"]) == 2
        assert a["traffic_state"] in ("CLEAR", "YIELDING", "REROUTED")
        assert isinstance(a["route"], list)
        if a["route"]:
            assert len(a["route"]) >= 2
            assert all(len(p) == 2 for p in a["route"])
            assert 0.0 <= a["route_progress"] <= 1.0


def test_idle_amrs_park_at_home():
    """§47.2：無任務且已返航的 AMR 停在充電位（不堵走廊）。"""
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    for i in range(36000):
        e.step()
        if i % 100 == 0:
            for a in e.amrs:
                if a["task"] is None and a["task_state"] in ("IDLE", "CHARGING"):
                    hx, hz = AMR_HOME[a["amr_id"]]
                    assert abs(a["pos"][0] - hx) + abs(a["pos"][1] - hz) <= 0.6


def test_traffic_determinism_with_obstacle():
    """§47.7：含障礙注入的完整重播 → dump 完全一致。"""
    def run() -> str:
        e = FactoryEngine(run_id="T", seed=42)
        e.preroll()
        for _ in range(6000):
            e.step()
        e.inject("amr_obstacle", "AMR-02", 45)
        for _ in range(12000):
            e.step()
        return json.dumps(e.dump_state(hashable=True), sort_keys=True)
    assert run() == run()


def test_waiting_amr_does_not_drain_battery():
    """§47.4：停等（障礙／讓行，馬達停止）期間不按任務費率耗電。"""
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    # 找到（或等到）一台執行任務中的 AMR，對它注入障礙 → WAITING
    for _ in range(72000):
        e.step()
        busy = [a for a in e.amrs if a["task"] is not None
                and a["task_state"].startswith("TRAVEL")]
        if busy:
            break
    assert busy, "no traveling AMR found"
    a = busy[0]
    e.inject("amr_obstacle", a["amr_id"], 120)
    for _ in range(20):
        e.step()                    # 進入 WAITING
    assert a["status"] == "WAITING"
    b0 = a["battery"]
    for _ in range(600):            # 60 秒停等
        e.step()
    assert a["battery"] >= b0 - 1e-9


def test_zone_obstacle_placement_is_validated():
    """障礙物不得生成在 AMR 車身／安全距內、dock 正位上、與既有障礙
    重疊；半徑必須為正——皆拒絕（ValueError → API 422）並說明原因。"""
    import pytest
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    a = e.amrs[0]
    with pytest.raises(ValueError, match="clearance"):
        e.inject("zone_obstacle", "custom", 60, extra={"x": a["pos"][0], "z": a["pos"][1]})
    with pytest.raises(ValueError, match="radius"):
        e.inject("zone_obstacle", "corridor_east", 60, extra={"radius": -2.0})
    with pytest.raises(ValueError, match="dock"):
        e.inject("zone_obstacle", "custom", 60, extra={"x": -44.0, "z": 21.5})
    e.inject("zone_obstacle", "corridor_east", 60)
    with pytest.raises(ValueError, match="overlaps"):
        e.inject("zone_obstacle", "custom", 60, extra={"x": 20.5, "z": 14.3})
    assert len(e.obstacles) == 1
    # 生成後任何 AMR 仍距障礙 ≥ 半徑 + hard_stop（拒絕邏輯的效果）
    hs = e.params["intralogistics"]["traffic"]["hard_stop_m"]
    ob = e.obstacles[0]
    for x in e.amrs:
        assert math.hypot(x["pos"][0] - ob["x"], x["pos"][1] - ob["z"]) >= ob["radius"] + hs


def test_obstacle_behind_amr_does_not_reroute():
    """障礙放在已走過的路段（車後方）→ 不觸發改道。
    掃描 2h 找到「車後方有合法放置點」的情境（離 dock ≥ 2.5、離所有 AMR ≥ 淨空）。"""
    from domain_factory.engine import AMR_DOCKS
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    hs = e.params["intralogistics"]["traffic"]["hard_stop_m"]
    found = None
    for _ in range(72000):
        e.step()
        for a in e.amrs:
            if not (a["task_state"].startswith("TRAVEL") or a["task_state"] == "RETURNING") \
                    or len(a["route"]) < 3 or not a["phase_total"]:
                continue
            f = 1.0 - a["phase_remaining"] / a["phase_total"]
            lens = FactoryEngine._seg_lens(a["route"])
            total = sum(lens) or 1.0
            acc = 0.0
            for i, seg in enumerate(lens):
                acc += seg
                if acc / total >= f - 0.05:
                    break
                pt = a["route"][i + 1]
                ok_dock = all(math.hypot(pt[0] - dx, pt[1] - dz) >= 2.5
                              for dx, dz in AMR_DOCKS.values())
                ok_amr = all(math.hypot(pt[0] - x["pos"][0], pt[1] - x["pos"][1])
                             >= 1.5 + hs + 0.3 for x in e.amrs)
                if ok_dock and ok_amr:
                    found = (a, pt)
                    break
            if found:
                break
        if found:
            break
    assert found is not None, "no behind-the-AMR placement scenario found in 2h"
    a, site = found
    before = e.bus.seq
    e.inject("zone_obstacle", "custom", 30, extra={"x": site[0], "z": site[1]})
    msgs = [x["message"] for x in e.bus.after(before)[0] if x["event_type"] == "AMR_REROUTED"]
    assert not any(a["amr_id"] in m for m in msgs), msgs


def _first_travel(e: FactoryEngine) -> None:
    for _ in range(20000):
        e.step()
        if any(a["task_state"].startswith("TRAVEL") for a in e.amrs):
            return


def test_obstacle_blocking_every_lane_is_rejected():
    """§53：淨空同時蓋住主／備援四條車道的障礙 → 422（ValueError），
    不讓 AMR 進入永久無路可走。"""
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    _first_travel(e)
    try:
        e.inject("zone_obstacle", "custom", 90, extra={"x": 0.0, "z": 16.1, "radius": 4.0})
        assert False, "should be rejected"
    except ValueError as ex:
        assert "every corridor lane" in str(ex)
    assert e.obstacles == []


def test_no_safe_path_holds_with_single_event_and_recovers():
    """§53：兩個各自合法的障礙合起來封住所有車道 → 受影響的 AMR 進入
    NO_SAFE_PATH：wire traffic_state=BLOCKED、status WAITING、只發一次 AMR_PATH_BLOCKED、
    不宣稱 DETOUR／REROUTED 風暴（40 s 內 AMR 事件 ≤ 3）；障礙到期後 AMR_PATH_CLEAR 並續行。"""
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    _first_travel(e)
    b = e.bus.seq
    e.inject("zone_obstacle", "custom", 120, extra={"x": 0.0, "z": 14.3, "radius": 1.0})
    e.inject("zone_obstacle", "custom", 120, extra={"x": 0.0, "z": 17.9, "radius": 1.0})
    for _ in range(400):                                 # 40 s
        e.step()
    evs = [x for x in e.bus.after(b)[0] if x["source_type"] == "AMR"]
    kinds = [x["event_type"] for x in evs]
    assert kinds.count("AMR_PATH_BLOCKED") == 1, kinds
    assert kinds.count("AMR_DETOUR") == 0 and kinds.count("AMR_REROUTED") <= 1, kinds
    assert len(evs) <= 3, kinds
    snap = snapshot_message(e)
    blocked = [a for a in snap["state"]["amrs"] if a["traffic_state"] == "BLOCKED"]
    assert blocked and all(a["status"] == "WAITING" for a in blocked)
    pos0 = {a["amr_id"]: list(a["pos"]) for a in e.amrs if a.get("path_blocked")}
    for _ in range(100):
        e.step()
    for aid, p in pos0.items():                          # 等待期間原地不動（不亂繞、不穿越）
        a = next(x for x in e.amrs if x["amr_id"] == aid)
        assert math.hypot(a["pos"][0] - p[0], a["pos"][1] - p[1]) < 0.01
    for _ in range(1200):                                # 障礙到期（120 s）
        e.step()
    kinds = [x["event_type"] for x in e.bus.after(b)[0] if x["source_type"] == "AMR"]
    assert kinds.count("AMR_PATH_BLOCKED") == 1 and kinds.count("AMR_PATH_CLEAR") == 1, kinds
    assert not any(a.get("path_blocked") for a in e.amrs)
    assert all(a["traffic_state"] != "BLOCKED" for a in snapshot_message(e)["state"]["amrs"])

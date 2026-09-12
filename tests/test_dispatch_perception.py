"""§51 派工 Decision Record 與感知層（WareTwin 借鏡）：因果可見、決定性、wire 驗證。"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages"))

from domain_factory.engine import DECISION_RING, FactoryEngine  # noqa: E402
from domain_factory.models import AmrPatchMessage, SnapshotMessage  # noqa: E402
from domain_factory.serialize import amr_patch_message, snapshot_message  # noqa: E402


def _engine() -> FactoryEngine:
    e = FactoryEngine(run_id="T", seed=42)
    e.preroll()
    return e


def test_decision_records_explain_every_assignment():
    """每次 TASK_STARTED 都有對應的 Decision Record：chosen 一致、候選含全部 AMR、
    落選者有原因、選中者 rank 1；延後紀錄 chosen=None 且每台都有原因。"""
    e = _engine()
    before = e.bus.seq
    for _ in range(18000):          # 30 min
        e.step()
    decs = e.decisions
    assert 1 <= len(decs) <= DECISION_RING
    evs = e.bus.after(before)[0]
    events = [ev for ev in evs if ev["event_type"] == "TASK_STARTED"]
    started = {ev["message"].split()[0]: ev["source_id"] for ev in events}
    assigned = [d for d in decs if d["chosen"]]
    assert assigned, "no assignment recorded"
    for d in decs:
        assert {c["amr_id"] for c in d["candidates"]} == {a["amr_id"] for a in e.amrs}
        assert d["rule"].startswith("priority")
        if d["chosen"] is None:
            assert d["reason"].startswith("deferred")
            assert all(c["rejected_reason"] and not c["eligible"] for c in d["candidates"])
        else:
            if d["task_id"] in started:
                assert started[d["task_id"]] == d["chosen"]
            win = next(c for c in d["candidates"] if c["amr_id"] == d["chosen"])
            assert win["eligible"] and win["rank"] == 1 and win["rejected_reason"] is None
            assert d["chosen"] in d["reason"]
            for c in d["candidates"]:
                if c["amr_id"] != d["chosen"]:
                    assert c["rejected_reason"], c
    # 事件流也留下 DISPATCH_DECISION（因果可從 Audit/Events 追）
    assert any(ev["event_type"] == "DISPATCH_DECISION" for ev in evs)


def test_dispatch_prefers_class_then_nearest():
    """規則：偏好類 → 最近取貨點 → amr_id。人工構造兩台皆適格、非偏好者較近：
    仍選偏好者；兩台同為非偏好時選較近者，理由句指名距離。"""
    e = _engine()
    a1, a2 = e.amrs
    for a in (a1, a2):
        a["task"], a["task_state"], a["status"] = None, "IDLE", "IDLE"
        a["battery"] = 90.0
    px, pz = e._pickup_dock({"type": "CELL_REPLENISH", "priority": 1})
    a1["pos"] = [px + 30.0, pz]            # 偏好補料類，但遠
    a2["pos"] = [px + 2.0, pz]             # 非偏好，近
    task = {"task_id": "T-X1", "type": "CELL_REPLENISH", "target": "welding",
            "priority": 1, "created_tick": e.clock.tick}
    c = e._dispatch_candidates(task, 20.0)
    ranks = {x["amr_id"]: x["rank"] for x in c}
    assert ranks["AMR-01"] == 1 and ranks["AMR-02"] == 2
    rec = e._record_decision(task, c, a1)
    assert "preferred class" in rec["reason"]
    loser = next(x for x in rec["candidates"] if x["amr_id"] == "AMR-02")
    assert loser["rejected_reason"].startswith("outranked by AMR-01: preferred class")
    # 兩台同為非偏好（FG_COLLECT priority 2 對 AMR-01 是非偏好；AMR-02 偏好）→ 改用
    # 同 priority 3 的任務：兩台皆非偏好 → 最近者
    task2 = {"task_id": "T-X2", "type": "RAW_REPLENISH", "target": "raw_material",
             "priority": 3, "created_tick": e.clock.tick}
    c2 = e._dispatch_candidates(task2, 20.0)
    ranks2 = {x["amr_id"]: x["rank"] for x in c2}
    assert ranks2["AMR-02"] == 1
    rec2 = e._record_decision(task2, c2, a2)
    assert "nearest to pickup" in rec2["reason"]
    # 電量門檻：低於 floor 的車不適格且理由明確
    a2["battery"] = 10.0
    c3 = e._dispatch_candidates(task2, 20.0)
    low = next(x for x in c3 if x["amr_id"] == "AMR-02")
    assert not low["eligible"] and "dispatch floor" in low["rejected_reason"]


def test_decisions_deterministic_and_persist_through_dump_load():
    e1, e2 = _engine(), _engine()
    for _ in range(6000):
        e1.step(); e2.step()
    assert e1.decisions == e2.decisions
    d = e1.dump_state()
    e3 = FactoryEngine(run_id="T", seed=42)
    e3.load_state(d)
    assert e3.decisions == e1.decisions
    for _ in range(3000):
        e1.step(); e3.step()
    assert e1.decisions == e3.decisions


def test_perception_geometry_and_state():
    """感知結構：距離語意依 ref（他車=中心距、障礙物=到邊緣）、方位 0=前方／正=左；前方近車 → CAUTION；
    讓行中 → STOPPED；側後方的車不算 ahead。"""
    e = _engine()
    a1, a2 = e.amrs
    tr = e.params["intralogistics"]["traffic"]
    a1["route"] = [[0.0, 14.3], [20.0, 14.3]]         # 朝 +x 行進
    a1["phase_total"], a1["phase_remaining"] = 10.0, 10.0
    a1["pos"] = [0.0, 14.3]
    a1["yielding"], a1["status"] = False, "DELIVERING"
    a2["pos"] = [2.2, 14.3]                            # 正前方 2.2 m（< clear 2.6）
    p = e.perception(a1)
    assert p["heading"] == [1.0, 0.0]
    assert p["state"] == "CAUTION" and p["ahead_m"] == 2.2 and p["nearest_m"] == 2.2
    assert p["obstacles"][0] == {"kind": "amr", "id": "AMR-02", "distance_m": 2.2, "bearing_deg": 0.0,
                                 "ref": "center", "radius_m": 0.0}     # 他車＝中心距（§47 門檻含車身）
    assert p["safe_m"] == tr["safe_distance_m"] and p["clear_m"] == tr["clear_distance_m"]
    a2["pos"] = [0.0, 17.3]                            # 正左方 3 m（+z 為左）
    p = e.perception(a1)
    assert p["obstacles"][0]["bearing_deg"] == 90.0 and p["ahead_m"] is None
    assert p["state"] == "CLEAR"
    a2["pos"] = [-3.0, 14.3]                           # 正後方 → 方位 ±180、不算前方
    p = e.perception(a1)
    assert abs(p["obstacles"][0]["bearing_deg"]) == 180.0 and p["ahead_m"] is None
    a2["pos"] = [40.0, 14.3]                           # 超出感測範圍
    assert e.perception(a1)["obstacles"] == []
    # 障礙物：距離扣半徑
    e.obstacles.append({"obstacle_id": "OBS-T", "x": 4.0, "z": 14.3, "radius": 1.5,
                        "until": e.clock.tick + 100, "label": "test"})
    p = e.perception(a1)
    ob = next(o for o in p["obstacles"] if o["kind"] == "obstacle")
    assert ob["distance_m"] == 2.5 and ob["bearing_deg"] == 0.0
    assert ob["ref"] == "edge" and ob["radius_m"] == 1.5          # 障礙物＝到邊緣（中心距 4.0 − 1.5）
    a1["yielding"] = True
    assert e.perception(a1)["state"] == "STOPPED"


def test_perception_on_wire_snapshot_and_patch():
    """snapshot／amr_patch 均帶 perception 且通過 schema；讓行時 wire 上 STOPPED 與
    traffic_state YIELDING 一致（畫面扇形＝引擎判斷）。"""
    e = _engine()
    m = snapshot_message(e)
    SnapshotMessage.model_validate(m)
    for a in m["state"]["amrs"]:
        assert a["perception"]["state"] in ("CLEAR", "CAUTION", "STOPPED")
    assert 1 <= len(m["state"]["dispatch_decisions"]) <= 8
    prev: dict = {}
    amr_patch_message(e, prev)
    seen_stop = False
    for _ in range(36000):
        e.step()
        pm = amr_patch_message(e, prev)
        if pm is None:
            continue
        AmrPatchMessage.model_validate(pm)
        for d in pm["amrs"]:
            if "perception" in d and d["perception"]["state"] == "STOPPED":
                seen_stop = True
                full = prev[d["amr_id"]]
                assert full["traffic_state"] == "YIELDING" or full["status"] == "WAITING"
    assert seen_stop, "no yielding observed in 1 h (traffic test premise)"


def test_dispatch_assigns_rank1_not_first_in_amr_order():
    """兩台同時適格且 AMR-02 排名第一（偏好類）時，實際派工必須是 AMR-02，
    且 Decision Record 的 chosen 與 TASK_STARTED 的車一致。"""
    e = _engine()
    a1, a2 = e.amrs
    for a in (a1, a2):
        a["task"], a["task_state"], a["status"] = None, "IDLE", "IDLE"
        a["battery"] = 95.0
        a["route"], a["phase_total"], a["phase_remaining"] = [], 0.0, 0.0
    e.amr_queue.clear()
    # FG_COLLECT priority 2 → AMR-02 偏好類；AMR-01 非偏好但在 AMR 順序上排前
    px, pz = e._pickup_dock({"type": "FG_COLLECT", "priority": 2})
    a1["pos"] = [px + 1.0, pz]              # AMR-01 甚至更近，仍應輸給偏好類
    a2["pos"] = [px + 9.0, pz]
    task = e._order_task("FG_COLLECT", "finished_goods", 20)
    before = e.bus.seq
    e._amr_orders_tick(0.5, e.params["intralogistics"], e.params["buffers"]["raw_material"])
    assert a2["task"] is task and a1["task"] is None
    rec = e.decisions[-1]
    assert rec["task_id"] == task["task_id"] and rec["chosen"] == "AMR-02"
    started = [ev for ev in e.bus.after(before)[0] if ev["event_type"] == "TASK_STARTED"]
    assert started and started[0]["source_id"] == "AMR-02"

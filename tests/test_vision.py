"""Vision Inspection 驗收（§16.4）— 確定性渲染、模型品質、ground truth 分離。"""
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))

from domain_factory.engine import FactoryEngine  # noqa: E402
from domain_factory.vision import (CLASSES, VisionInspector, features,  # noqa: E402
                                   locate_defect, render_part_image)


def test_render_deterministic():
    a = render_part_image(42, "PART-00001", "scratch")
    b = render_part_image(42, "PART-00001", "scratch")
    assert np.array_equal(a, b)
    c = render_part_image(42, "PART-00002", "scratch")
    assert not np.array_equal(a, c)                 # 不同零件 → 不同影像


def test_defect_visibly_differs_from_ok():
    for defect in CLASSES[1:]:
        img = render_part_image(7, "PART-X", defect)
        ref = render_part_image(7, "PART-X", "ok")
        assert locate_defect(img, ref) is not None, defect
    assert locate_defect(render_part_image(7, "PART-X", "ok"),
                         render_part_image(7, "PART-X", "ok")) is None


@pytest.fixture(scope="module")
def inspector():
    return VisionInspector()


def test_model_loaded_and_accurate(inspector):
    """ONNX 模型存在且 held-out 準確率 ≥ 0.9（訓練腳本輸出的誠實指標）。"""
    assert inspector.source == "onnx"
    assert inspector.meta["held_out_accuracy"] >= 0.9
    assert inspector.meta["classes"] == CLASSES


def test_inference_on_fresh_parts(inspector):
    """模型對「訓練時沒看過的 part_id」仍準確（泛化，非背答案）。"""
    correct = 0
    n = 0
    for i, gt in enumerate(CLASSES * 5):
        r = inspector.infer(99, f"FRESH-{i:03d}", gt)
        n += 1
        correct += r["agreement"]
        assert 0 <= r["confidence"] <= 1
        if r["predicted"] != "ok":
            assert r["bbox"] is not None
    assert correct / n >= 0.85


def test_engine_records_ground_truth_and_stays_deterministic():
    """引擎記錄 recent_inspections；加入視覺後生產路由不變（RNG 消耗不變）。"""
    a = FactoryEngine(seed=42)
    a.run_ticks(40_000)
    assert len(a.recent_inspections) > 10
    fails = [r for r in a.recent_inspections if r["ground_truth"] != "ok"]
    for r in fails:
        assert r["ground_truth"] in CLASSES[1:]
    b = FactoryEngine(seed=42)
    b.run_ticks(40_000)
    assert a.state_hash() == b.state_hash()


def test_perception_vs_ground_truth_separation(inspector):
    """感知錯誤不影響帳目：模型只觀測，守恆與 KPI 仍由引擎 ground truth 決定。"""
    e = FactoryEngine(seed=42)
    e.run_ticks(40_000)
    e.check_conservation()
    good_before = e.good
    for rec in e.recent_inspections[-5:]:
        inspector.infer(42, rec["part_id"], rec["ground_truth"])
    assert e.good == good_before                    # 觀測不改變權威狀態
    e.check_conservation()


def test_features_shape():
    f = features(render_part_image(1, "P", "ok"))
    assert f.shape == (1024,) and f.dtype == np.float32

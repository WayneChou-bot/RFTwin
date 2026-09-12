"""訓練視覺檢測分類器 → ONNX（§16.4）。

資料：`vision.render_part_image` 合成影像（訓練/測試 split 用不同 part_id 空間，
確保泛化評估誠實）。模型：sklearn MLPClassifier（1024→64→4）→ skl2onnx。
輸出：assets/vision/inspector.onnx + inspector.meta.json（含 held-out 指標）。
"""
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))

from domain_factory.vision import ASSET_DIR, CLASSES, features, render_part_image  # noqa: E402

SEED = 1234
N_PER_CLASS_TRAIN = 400
N_PER_CLASS_TEST = 100


def make_set(prefix: str, n_per_class: int) -> tuple[np.ndarray, np.ndarray]:
    xs, ys = [], []
    for ci, cls in enumerate(CLASSES):
        for i in range(n_per_class):
            img = render_part_image(SEED, f"{prefix}-{cls}-{i:04d}", cls)
            xs.append(features(img))
            ys.append(ci)
    return np.array(xs, np.float32), np.array(ys, np.int64)


def main() -> None:
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
    from sklearn.metrics import accuracy_score, confusion_matrix
    from sklearn.neural_network import MLPClassifier

    t0 = time.time()
    x_tr, y_tr = make_set("TRAIN", N_PER_CLASS_TRAIN)
    x_te, y_te = make_set("TEST", N_PER_CLASS_TEST)
    clf = MLPClassifier(hidden_layer_sizes=(64,), max_iter=300, random_state=SEED,
                        early_stopping=True, n_iter_no_change=15)
    clf.fit(x_tr, y_tr)
    pred = clf.predict(x_te)
    acc = accuracy_score(y_te, pred)
    cm = confusion_matrix(y_te, pred).tolist()
    # false reject = ok 被判成缺陷；false accept = 缺陷被判成 ok
    ok_idx = CLASSES.index("ok")
    fr = sum(cm[ok_idx][j] for j in range(len(CLASSES)) if j != ok_idx) / N_PER_CLASS_TEST
    fa = sum(cm[i][ok_idx] for i in range(len(CLASSES)) if i != ok_idx) / \
        (N_PER_CLASS_TEST * (len(CLASSES) - 1))

    onx = convert_sklearn(clf, initial_types=[("input", FloatTensorType([None, 1024]))],
                          options={id(clf): {"zipmap": False}})
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    (ASSET_DIR / "inspector.onnx").write_bytes(onx.SerializeToString())
    meta = {
        "version": "insp-1.0", "classes": CLASSES, "input": "gray32x32.flatten",
        "train_per_class": N_PER_CLASS_TRAIN, "test_per_class": N_PER_CLASS_TEST,
        "held_out_accuracy": round(float(acc), 4),
        "false_reject_rate": round(float(fr), 4),
        "false_accept_rate": round(float(fa), 4),
        "confusion_matrix": cm, "train_seed": SEED,
        "trained_in_sec": round(time.time() - t0, 1),
        "note": "synthetic golden-sample images; simulation asset, not a real-world model",
    }
    (ASSET_DIR / "inspector.meta.json").write_text(
        json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"accuracy={acc:.4f} FR={fr:.3f} FA={fa:.3f} "
          f"({time.time()-t0:.0f}s) → {ASSET_DIR/'inspector.onnx'}")


if __name__ == "__main__":
    main()

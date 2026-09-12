"""Vision Inspection（§16.4）。

架構：**ground truth 與感知分離** —— 引擎照舊決定零件真實狀態（生產路由不變），
本模組負責「感知」：

1. `render_part_image(seed, part_id, defect)`：確定性合成 64×64 工件影像
   （PCB 風格：基板、四角螺絲、晶片、接點列）。缺陷三類：scratch（亮痕）、
   missing_component（晶片缺件）、misalignment（晶片偏移旋轉）。
2. `VisionInspector`：ONNX 分類器（sklearn MLP → skl2onnx，離線訓練）判定類別
   與信心；缺陷定位用模板差異（與同 seed 的無缺陷渲染比對 → bbox），
   即傳統 AOI 的 golden-sample 比對。模型檔缺失時退回純模板啟發式
   （Adapter 原則：感知層可插拔，引擎不依賴）。
"""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

import numpy as np

CLASSES = ["ok", "scratch", "missing_component", "misalignment"]
IMG = 64
ASSET_DIR = Path(__file__).resolve().parents[2] / "assets" / "vision"


def _rng_for(seed: int, part_id: str, defect: str) -> np.random.Generator:
    h = hashlib.sha256(f"{seed}:{part_id}:{defect}".encode()).digest()
    return np.random.default_rng(int.from_bytes(h[:8], "big"))


def render_part_image(seed: int, part_id: str, defect: str = "ok") -> np.ndarray:
    """確定性合成影像 → float32 [64,64,3]（0–1）。相同輸入位元級相同。"""
    rng = _rng_for(seed, part_id, "base")          # 幾何由 part 決定，與 defect 無關
    img = np.full((IMG, IMG, 3), 0.13, np.float32)
    img += rng.normal(0, 0.012, img.shape).astype(np.float32)   # 感光雜訊（低）
    # 基板
    img[6:58, 6:58] = [0.10, 0.22, 0.16]
    # 四角螺絲
    for cx, cy in [(11, 11), (11, 53), (53, 11), (53, 53)]:
        yy, xx = np.ogrid[:IMG, :IMG]
        mask = (xx - cx) ** 2 + (yy - cy) ** 2 <= 9
        img[mask] = [0.55, 0.55, 0.58]
    # 接點列（下緣）
    for i in range(8):
        x = 12 + i * 5
        img[50:55, x:x + 3] = [0.75, 0.65, 0.25]
    # 晶片（缺陷影響區）
    chip_x, chip_y, cw, ch = 22, 18, 20, 16
    drng = _rng_for(seed, part_id, defect)
    if defect == "missing_component":
        # 只留焊盤痕跡
        img[chip_y:chip_y + ch, chip_x:chip_x + cw] = [0.14, 0.26, 0.19]
        img[chip_y + 2:chip_y + ch - 2:4, chip_x + 2:chip_x + cw - 2] = [0.6, 0.55, 0.3]
    elif defect == "misalignment":
        dx = int(drng.integers(4, 8)) * (1 if drng.random() < 0.5 else -1)
        dy = int(drng.integers(2, 5))
        x0, y0 = chip_x + dx, chip_y + dy
        img[y0:y0 + ch, x0:x0 + cw] = [0.06, 0.06, 0.07]
        img[y0 + 3:y0 + 6, x0 + 2:x0 + cw - 2] = [0.85, 0.85, 0.85]
    else:
        img[chip_y:chip_y + ch, chip_x:chip_x + cw] = [0.06, 0.06, 0.07]
        img[chip_y + 3:chip_y + 6, chip_x + 2:chip_x + cw - 2] = [0.85, 0.85, 0.85]
    if defect == "scratch":
        x1, y1 = int(drng.integers(8, 30)), int(drng.integers(10, 50))
        length, slope = int(drng.integers(18, 34)), drng.uniform(-0.6, 0.6)
        for t in range(length):
            x, y = x1 + t, int(y1 + t * slope)
            if 0 <= x < IMG and 1 <= y < IMG - 1:
                img[y - 1:y + 1, x] = [0.9, 0.9, 0.88]
    return np.clip(img, 0, 1)


def to_png(img: np.ndarray, scale: int = 4) -> bytes:
    from PIL import Image
    arr = (img * 255).astype(np.uint8)
    im = Image.fromarray(arr).resize((IMG * scale, IMG * scale), Image.NEAREST)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def features(img: np.ndarray) -> np.ndarray:
    """模型輸入：32×32 灰階攤平（1024 維，float32）。"""
    gray = img.mean(axis=2)
    small = gray.reshape(32, 2, 32, 2).mean(axis=(1, 3))
    return small.reshape(-1).astype(np.float32)


def locate_defect(img: np.ndarray, reference: np.ndarray) -> list[float] | None:
    """Golden-sample 模板比對 → 正規化 bbox [x, y, w, h]（無顯著差異 → None）。"""
    diff = np.abs(img.mean(axis=2) - reference.mean(axis=2))
    mask = diff > 0.12
    if mask.sum() < 8:
        return None
    ys, xs = np.where(mask)
    x0, x1 = xs.min(), xs.max()
    y0, y1 = ys.min(), ys.max()
    return [round(float(x0) / IMG, 3), round(float(y0) / IMG, 3),
            round(float(x1 - x0 + 1) / IMG, 3), round(float(y1 - y0 + 1) / IMG, 3)]


class VisionInspector:
    """ONNX 分類 + 模板定位。模型缺失 → heuristic fallback（source 標示）。"""

    def __init__(self, asset_dir: Path = ASSET_DIR):
        self.session = None
        self.meta: dict = {}
        model = asset_dir / "inspector.onnx"
        meta = asset_dir / "inspector.meta.json"
        if model.exists() and meta.exists():
            try:
                import onnxruntime as ort
                self.session = ort.InferenceSession(str(model),
                                                    providers=["CPUExecutionProvider"])
                self.meta = json.loads(meta.read_text(encoding="utf-8"))
            except Exception:
                self.session = None

    @property
    def source(self) -> str:
        return "onnx" if self.session is not None else "heuristic"

    def infer(self, seed: int, part_id: str, ground_truth: str) -> dict:
        img = render_part_image(seed, part_id, ground_truth)
        ref = render_part_image(seed, part_id, "ok")
        bbox = locate_defect(img, ref)
        if self.session is not None:
            x = features(img)[None, :]
            out = self.session.run(None, {self.session.get_inputs()[0].name: x})
            # skl2onnx MLPClassifier 輸出：[label, prob(map/array)]
            probs = out[1]
            if isinstance(probs, list):                      # ZipMap → list[dict]
                pmap = probs[0]
                pred = max(pmap, key=pmap.get)
                conf = float(pmap[pred])
                pred = CLASSES[int(pred)] if isinstance(pred, (int, np.integer)) else str(pred)
            else:
                idx = int(np.argmax(probs[0]))
                pred = CLASSES[idx]
                conf = float(probs[0][idx])
        else:                                                # 啟發式：模板差異量
            if bbox is None:
                pred, conf = "ok", 0.7
            else:
                # 差異區域形狀粗判
                w, h = bbox[2], bbox[3]
                pred = "scratch" if w > 0.25 and h < 0.2 else \
                    "misalignment" if w > 0.3 else "missing_component"
                conf = 0.55
        return {
            "part_id": part_id, "ground_truth": ground_truth,
            "predicted": pred, "confidence": round(conf, 3),
            "verdict": "PASS" if pred == "ok" else "FAIL",
            "bbox": bbox if pred != "ok" else None,
            "agreement": pred == ground_truth,
            "model_source": self.source,
            "model_version": self.meta.get("version", "heuristic"),
        }

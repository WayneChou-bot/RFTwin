"""Pydantic → JSON Schema（ADR-003 第一段）。輸出至 schemas/。"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))

from domain_factory.models import WIRE_MODELS  # noqa: E402

out = ROOT / "schemas"
out.mkdir(exist_ok=True)
for model in WIRE_MODELS:
    schema = model.model_json_schema()
    schema["$schema"] = "http://json-schema.org/draft-07/schema#"
    name = model.__name__
    path = out / f"{name}.schema.json"
    path.write_text(json.dumps(schema, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT)}")

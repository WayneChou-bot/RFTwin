"""§50：把 config/factory_layout.json 同步到 frontend/src/layout/factory_layout.json。
前端副本是產生物（禁止手改）；tests/test_layout.py 驗證兩份一致。
用法：python scripts/sync_layout.py [--check]（--check：只比對，不同步則 exit 1，供 CI）"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "config" / "factory_layout.json"
DST = ROOT / "frontend" / "src" / "layout" / "factory_layout.json"


def main() -> int:
    DST.parent.mkdir(parents=True, exist_ok=True)
    json.loads(SRC.read_text(encoding="utf-8"))          # 驗證是合法 JSON
    if "--check" in sys.argv:
        same = DST.exists() and DST.read_bytes() == SRC.read_bytes()
        print("layout in sync" if same else "layout copy out of date — run scripts/sync_layout.py")
        return 0 if same else 1
    shutil.copyfile(SRC, DST)
    print(f"synced {SRC.relative_to(ROOT)} → {DST.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

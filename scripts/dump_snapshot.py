"""Engine pre-roll → canonical fixture。

用法：python3 scripts/dump_snapshot.py [--seed 42]
輸出：fixtures/snapshot.live-001.json（相同 wire schema，AJV／pytest 不變）
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages"))

from domain_factory.engine import FactoryEngine  # noqa: E402
from domain_factory.serialize import snapshot_message  # noqa: E402

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    eng = FactoryEngine(seed=args.seed)
    eng.preroll()
    msg = snapshot_message(eng)
    out = ROOT / "fixtures" / "snapshot.live-001.json"
    out.write_text(json.dumps(msg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    k = msg["state"]["kpis"]
    print(f"wrote {out.name}: engine={msg['provenance']['engine_version']} "
          f"good={k['good_units']} oee={k['oee']['oee']} seq={msg['seq']} "
          f"wip={msg['state']['parts']['wip']}")

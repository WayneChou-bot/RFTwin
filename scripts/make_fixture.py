"""[已退役 — Phase 2] fixture 改由模擬引擎輸出。

Phase 1 的封閉式 fixture generator 已依規劃刪除（見 README「Phase 2 交接備忘」）。
請改用：

    python3 scripts/dump_snapshot.py --seed 42

它以 FactoryEngine 跑完整 pre-roll（144,000 ticks）後輸出相同 wire schema 的
fixtures/snapshot.live-001.json。
"""
import subprocess
import sys
from pathlib import Path

if __name__ == "__main__":
    print(__doc__)
    sys.exit(subprocess.call([sys.executable,
                              str(Path(__file__).with_name("dump_snapshot.py")), *sys.argv[1:]]))

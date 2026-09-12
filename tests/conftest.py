"""pytest 全域環境：後端防護層在測試中的設定（guard／main 於 import 時讀取）。
- TWIN_RATE_LIMIT=0：API 語意測試不受限流影響（限流本身由 test_guard 以 monkeypatch 開啟驗證）。
- TWIN_WS_SEND_TIMEOUT_S=0：Starlette TestClient 的記憶體 WebSocket 不容許在 send 外包 cancel
  scope（訊息會遺失）；慢連線逾時在真 uvicorn 下由 Live e2e 覆蓋（§53）。"""
import os

os.environ.setdefault("TWIN_RATE_LIMIT", "0")
os.environ.setdefault("TWIN_WS_SEND_TIMEOUT_S", "0")

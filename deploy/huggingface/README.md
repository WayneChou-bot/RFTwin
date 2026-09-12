---
title: RFTwin Backend
emoji: 🏭
colorFrom: blue
colorTo: gray
sdk: docker
app_port: 8000
pinned: false
license: mit
short_description: Simulation backend (FastAPI + WebSocket) for Robot Factory Digital Twin
---

# Robot Factory Digital Twin — backend

Authoritative simulation engine + REST/WebSocket API for
[RFTwin](https://github.com/WayneChou-bot/RFTwin). The 3D frontend is served separately (Vercel);
this Space only exposes `/api/*`, `/ws` and `/api/health`.

The Dockerfile clones the GitHub repository at build time (`RFTWIN_REF`, default `main`).
To pick up a new commit, bump `CACHE_BUST` in the Dockerfile or use *Settings → Factory rebuild*.

Required Space variable: `TWIN_CORS_ORIGINS=https://<your-frontend>.vercel.app`
(the backend accepts cross-site requests only from listed origins).

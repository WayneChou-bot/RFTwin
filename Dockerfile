# §50 單一容器部署（WareTwin 借鏡，簡化為一個服務）：
#   stage 1 建前端 dist（含 demo fixture）；stage 2 Python 後端同時服務 dist 與 API/WS。
#   → Render / Fly.io / 任何 container host 一個服務即可；不需要 Vercel 拆分。
FROM node:20-alpine AS web
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci --no-audit --no-fund
COPY frontend ./frontend
COPY config/factory_layout.json ./config/factory_layout.json
RUN cd frontend && npm run build

FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app/packages:/app \
    TWIN_RATE_LIMIT=1 TWIN_HEALTH_STALL_S=10
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY apps ./apps
COPY packages ./packages
COPY config ./config
COPY schemas ./schemas
COPY --from=web /src/frontend/dist ./frontend/dist
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"
CMD ["python", "-m", "uvicorn", "apps.factory_backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--ws", "wsproto"]

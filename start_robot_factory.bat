@echo off
REM Robot Factory Digital Twin — 一鍵啟動（§43.8）
REM 需求：conda/venv 已啟用（python 可用）、npm ci 已跑過
REM port 8000 被 Windows 保留（WinError 10013）時會自動改用 8010/8080/…；也可先 set TWIN_PORT=8010
cd /d "%~dp0"
npm run dev:all

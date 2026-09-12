#!/usr/bin/env node
/* 一鍵啟動（§43.8）：FastAPI（--reload）+ Vite dev，兩者共用同一個 backend port。
 *
 * 為什麼不用寫死 8000：Windows 上 Hyper-V／WSL2 會把一段動態 port 保留起來
 * （`netsh interface ipv4 show excludedportrange protocol=tcp`），8000 常常落在裡面，
 * uvicorn 直接 [WinError 10013] 起不來 → 前端只剩 Local Demo。
 * 這支腳本先探測可綁定的 port（TWIN_PORT 環境變數優先，否則 8000 → 8010 → 8080 →
 * 8800 → 18000），再把同一個 port 交給 uvicorn 與 vite（vite.config.ts 讀 TWIN_PORT
 * 決定 /api、/ws 轉發目標）。
 */
import net from "node:net";
import { spawn } from "node:child_process";

const CANDIDATES = [8000, 8010, 8080, 8800, 18000];

function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err) => resolve({ ok: false, code: err.code }));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      srv.close(() => resolve({ ok: true }));
    });
  });
}

async function pickPort() {
  const forced = process.env.TWIN_PORT;
  if (forced) {
    const r = await canBind(Number(forced));
    if (!r.ok) console.warn(`[dev] TWIN_PORT=${forced} 無法綁定（${r.code}），仍照你指定的嘗試啟動`);
    return Number(forced);
  }
  for (const p of CANDIDATES) {
    const r = await canBind(p);
    if (r.ok) {
      if (p !== 8000) console.warn(`[dev] port 8000 不可用，改用 ${p}`);
      return p;
    }
    console.warn(`[dev] port ${p} 不可用：${r.code}` +
      (r.code === "EACCES" || r.code === "EPERM"
        ? "（Windows 保留區段；可用 netsh interface ipv4 show excludedportrange protocol=tcp 查看）"
        : r.code === "EADDRINUSE" ? "（已被其他程式佔用）" : ""));
  }
  throw new Error("找不到可用的 backend port；請設定 TWIN_PORT=<port> 後重試");
}

const port = await pickPort();
const env = { ...process.env, TWIN_PORT: String(port) };
const shell = process.platform === "win32";
const procs = [
  ["api", "python", ["-m", "uvicorn", "apps.factory_backend.main:app", "--port", String(port), "--reload"]],
  ["web", "npm", ["--prefix", "frontend", "run", "dev"]],
].map(([name, cmd, args]) => {
  const child = spawn(cmd, args, { env, shell, stdio: ["ignore", "pipe", "pipe"] });
  const tag = (line) => `[${name}] ${line}`;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) process.stdout.write(tag(l) + "\n");
    });
  }
  child.on("exit", (code) => {
    process.stdout.write(tag(`exited with code ${code}`) + "\n");
    if (name === "api" && code !== 0) {
      process.stdout.write("[dev] backend 啟動失敗——前端會停在 Local Demo。請看上面的錯誤訊息。\n");
    }
  });
  return child;
});

console.log(`[dev] API: http://localhost:${port}  |  Dev UI: http://localhost:5173  (TWIN_PORT=${port})`);
const stop = () => { for (const p of procs) if (!p.killed) p.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

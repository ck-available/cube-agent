/* 实况测试启动器：node e2e/live.js [core|full] [--keep]
 * 用法与 e2e/run.js 相同的 Electron 拉起方式，但窗口是**可见的**，
 * 每一步会截图到 e2e/_artifacts/live/，用户可以亲眼看到测试过程。
 */
const path = require("path");
const fs = require("fs");

const mode = (process.argv[2] || "core").toLowerCase();
const keep = process.argv.includes("--keep") ? "1" : "";

if (process.versions && process.versions.electron) {
  const { app } = require("electron");
  app.disableHardwareAcceleration();
  app.whenReady().then(() => {
    // main.js 在 CUBEAGENT_E2E 存在时才会加载 driver，
    // 这里复用同一入口，只是额外挂上 live 驱动并强制显示窗口。
    process.env.CUBEAGENT_E2E = "1";
    process.env.CUBEAGENT_LIVE = "1";
    process.env.CUBEAGENT_LIVE_MODE = mode === "full" ? "full" : "core";
    if (keep) process.env.CUBEAGENT_LIVE_KEEP = "1";
    require(path.join(__dirname, "..", "electron", "main.js"));
  });
} else {
  const { spawnSync } = require("child_process");
  delete process.env.ELECTRON_RUN_AS_NODE;
  const electronPath = require("electron");
  const r = spawnSync(electronPath, [__filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
    windowsHide: false,
  });
  process.exit(r.status == null ? 1 : r.status);
}
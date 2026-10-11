/* 一键跑全部验证：免安装服务 → 上下文模块 → 桌面标准 → 桌面深度 → 浏览器端
 * 用法：node e2e/run-all.js   （或 npm run e2e:all）
 * 注意：深度用例会真实调用模型并耗时较久，可加 --quick 跳过模型相关套件。
 */
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const NODE = process.execPath;
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const quick = process.argv.includes("--quick");

const SUITES = [
  { name: "免安装服务接口", cmd: NODE, args: ["e2e/server-suite.js"], env: {} },
  { name: "上下文模块", cmd: NODE, args: ["e2e/context-suite.js"], env: {} },
  { name: "长期记忆", cmd: NODE, args: ["e2e/memory-suite.js"], env: {} },
  ...(quick ? [] : [
    { name: "桌面端标准", cmd: NODE, args: ["e2e/run.js"], env: {} },
    { name: "桌面端深度", cmd: NODE, args: ["e2e/run-deep.js"], env: {} }
  ]),
  { name: "浏览器端免安装", cmd: ELECTRON, args: ["e2e/web-suite.js"], env: { ELECTRON_RUN_AS_NODE: "" } }
];

const results = [];

function run(s) {
  return new Promise((resolve) => {
    console.log("");
    console.log("════════ " + s.name + " ════════");
    const env = Object.assign({}, process.env, s.env);
    // electron 系命令必须清掉 ELECTRON_RUN_AS_NODE，否则退化成纯 node 不建窗口
    if (!s.env || s.env.ELECTRON_RUN_AS_NODE === "") delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(s.cmd, s.args, { cwd: ROOT, env: env, stdio: "inherit", windowsHide: true });
    child.on("close", (code) => resolve({ name: s.name, code: code }));
    child.on("error", (e) => { console.error("启动失败：", e.message); resolve({ name: s.name, code: 1 }); });
  });
}

(async function () {
  const t0 = Date.now();
  for (const s of SUITES) {
    const r = await run(s);
    results.push(r);
  }
  console.log("");
  console.log("════════ 汇总 ════════");
  results.forEach((r) => {
    console.log("  " + (r.code === 0 ? "通过" : "失败") + "  " + r.name);
  });
  const bad = results.filter((r) => r.code !== 0);
  console.log("");
  console.log("  " + (results.length - bad.length) + " / " + results.length + " 套通过 · 用时 " +
    Math.round((Date.now() - t0) / 1000) + "s");
  process.exit(bad.length ? 1 : 0);
})();
/* 深度功能验证入口：npm run e2e:deep
 * 与 npm run e2e 的区别：加载 e2e/deep-suite.js，覆盖工具调用、写代码、
 * 长文本分析、上下文分析四类深度场景，报告输出到 e2e/_artifacts/deep-report.txt。
 */
const { spawnSync } = require("child_process");
const path = require("path");

delete process.env.ELECTRON_RUN_AS_NODE;
process.env.CUBEAGENT_E2E = "1";
process.env.CUBEAGENT_DEEP = "1";

const electronPath = require("electron");
const root = path.join(__dirname, "..");

/* 独立 userData：① 不污染用户真实数据 ② 与可能正在运行的 GUI 实例隔离（否则两边抢 localStorage） */
const userData = path.join(__dirname, "_artifacts", "deep-userdata");
require("fs").mkdirSync(userData, { recursive: true });

console.log("启动 Electron 客户端执行深度功能验证（真实模型 · 耗时较长）…");
console.log("electron:", electronPath);
console.log("userData:", userData);

const r = spawnSync(
  electronPath,
  [root, "--user-data-dir=" + userData],
  { stdio: "inherit", env: process.env, windowsHide: true }
);

const report = path.join(__dirname, "_artifacts", "deep-report.txt");
console.log("\n报告路径：" + report);
process.exit(r.status == null ? 1 : r.status);

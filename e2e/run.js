/* 端到端一键入口：npm run e2e
 * 用真实 Electron 客户端（隐藏窗口）跑全套用例，报告输出到 e2e/_artifacts/。
 * 注意：必须清掉 ELECTRON_RUN_AS_NODE，否则 electron 会以纯 Node 模式启动、拿不到窗口 API。
 */
const { spawnSync } = require("child_process");
const path = require("path");

delete process.env.ELECTRON_RUN_AS_NODE;
process.env.CUBEAGENT_E2E = "1";

const electronPath = require("electron"); // 纯 Node 下返回可执行文件路径
const root = path.join(__dirname, "..");

console.log("启动 Electron 客户端执行端到端验证…");
console.log("electron:", electronPath);

const r = spawnSync(electronPath, [root], { stdio: "inherit", env: process.env, windowsHide: true });

const report = path.join(__dirname, "_artifacts", "e2e-report.txt");
console.log("\n报告路径：" + report);
process.exit(r.status == null ? 1 : r.status);

/* 对打包产物执行自检：node e2e/run-packaged.js [exe路径]
 * Windows 打包后的 exe 是 GUI 子系统程序，不会阻塞控制台，
 * 因此这里用 spawn 启动后轮询报告文件，而不是同步等待进程。
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

/* 关键：某些终端环境预置了 ELECTRON_RUN_AS_NODE，会让 Electron 退化成纯 Node 进程，
 * 不创建窗口、不进入 E2E。必须清掉后再启动。 */
delete process.env.ELECTRON_RUN_AS_NODE;

const exe = process.argv[2] || path.join(__dirname, "..", "dist", "win-unpacked", "CubeAgent.exe");
if (!fs.existsSync(exe)) {
  console.error("找不到可执行文件：" + exe);
  process.exit(2);
}

/* CUBEAGENT_DEEP=1 → 跑深度套件（deep-report.txt），否则跑标准套件（e2e-report.txt） */
const DEEP = process.env.CUBEAGENT_DEEP === "1";
const REPORT_NAME = DEEP ? "deep-report" : "e2e-report";

/* 报告可能落在三个位置：便携数据目录 / 开发态 userData / 打包态 userData */
const ROOT = path.join(__dirname, "..");
const candidates = [
  path.join(path.dirname(exe), "CubeAgent-data", "e2e-artifacts", REPORT_NAME + ".txt"),
  path.join(path.join(ROOT, "dist"), "CubeAgent-data", "e2e-artifacts", REPORT_NAME + ".txt"),
  path.join(process.env.APPDATA || "", "cube-agent", "e2e-artifacts", REPORT_NAME + ".txt"),
  path.join(process.env.APPDATA || "", "CubeAgent", "e2e-artifacts", REPORT_NAME + ".txt"),
];
candidates.forEach((p) => { try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch (e) { /* ignore */ } });

console.log("对打包产物执行" + (DEEP ? "深度功能" : "端到端") + "自检：");
console.log("  " + exe);

const child = spawn(exe, [], {
  env: Object.assign({}, process.env, { CUBEAGENT_E2E: "1", CUBEAGENT_DEEP: DEEP ? "1" : "0" }),
  stdio: "inherit",
  windowsHide: true,
  detached: false,
});
child.on("error", (e) => console.error("启动失败：" + e.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const deadline = Date.now() + (DEEP ? 25 : 5) * 60 * 1000;
  let found = null;
  while (Date.now() < deadline) {
    for (const p of candidates) {
      if (fs.existsSync(p)) { found = p; break; }
    }
    if (found) break;
    await sleep(2000);
  }

  if (!found) {
    console.error("等待 " + (DEEP ? 25 : 5) + " 分钟仍未产出报告。可能未进入 E2E 模式。");
    try { child.kill(); } catch (e) { /* ignore */ }
    process.exit(1);
  }

  await sleep(600);
  const text = fs.readFileSync(found, "utf8");
  console.log("\n报告路径：" + found + "\n");
  console.log(text);

  try { child.kill(); } catch (e) { /* ignore */ }
  const m = text.match(/合计:\s*(\d+)\s*\/\s*(\d+)/);
  process.exit(m && m[1] === m[2] ? 0 : 1);
})();

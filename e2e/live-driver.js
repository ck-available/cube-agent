/* ============ CubeAgent 实况（可见窗口）测试驱动 ============
 * 与 driver.js 的区别：窗口**真实显示**在桌面上，每一步都截图落盘并实时打印，
 * 用户可以亲眼看到测试过程，而不是只拿到一份报告。
 *
 * 用法：
 *   node e2e/live.js core    # 核心高频功能（默认）
 *   node e2e/live.js full    # 核心 + 完整功能面
 *   node e2e/live.js core --keep   # 结束后不退出，方便手动查看
 *
 * 截图协议：渲染进程调用 __shot('步骤名') 把名字压进 window.__shotQueue，
 * 主进程每 300ms 轮询该队列并 capturePage。之所以用轮询而不是 IPC，
 * 是因为渲染进程开了 contextIsolation，页面里拿不到 ipcRenderer。
 *
 * 产物：e2e/_artifacts/live/<序号>-<步骤名>.png  +  live-report.txt / .json
 */
const fs = require("fs");
const path = require("path");

let ART = null;
let WS = null;
let SHOTS = null;
let REPORT = null;
let TEXT = null;
let LOG = null;
let win = null;
let app = null;

function log(msg) {
  const line = "[" + new Date().toLocaleTimeString() + "] " + msg;
  try { if (LOG) fs.appendFileSync(LOG, line + "\n", "utf8"); } catch (e) { /* ignore */ }
  try { console.log("[live] " + msg); } catch (e) { /* ignore */ }
}

/* 工作区要有真实可操作的项目，Agent 模式才跑得起来 */
function resetWorkspace() {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(path.join(WS, "src", "utils"), { recursive: true });
  fs.writeFileSync(path.join(WS, "README.md"),
    "# Live Demo\n\n这是一个用于实况验证的示例项目。\n\n- src/calc.js：加减法\n- src/utils/format.js：数字补零\n");
  fs.writeFileSync(path.join(WS, "src", "calc.js"),
    "function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add, sub };\n");
  fs.writeFileSync(path.join(WS, "src", "utils", "format.js"),
    "function pad(n) {\n  return n < 10 ? '0' + n : String(n);\n}\n\nmodule.exports = { pad };\n");
}

module.exports = function liveDriver(mainWin, electronApp) {
  win = mainWin;
  app = electronApp;

  try {
    ART = path.join(__dirname, "_artifacts");
    WS = path.join(ART, "live-workspace");
    SHOTS = path.join(ART, "live");
    REPORT = path.join(ART, "live-report.json");
    TEXT = path.join(ART, "live-report.txt");
    LOG = path.join(ART, "_live.log");
    fs.mkdirSync(SHOTS, { recursive: true });
    resetWorkspace();
    process.env.CUBEAGENT_TEST_WS = WS;
  } catch (e) {
    log("初始化失败: " + ((e && e.stack) || e));
    try { fs.writeFileSync(path.join(app.getPath("temp"), "cubeagent-live-failure.txt"),
      "初始化失败\n" + String((e && e.stack) || e), "utf8"); } catch (e2) { /* ignore */ }
    app.exit(3);
    return;
  }

  let started = false;
  let cleaned = false;
  let shotIdx = 0;
  let shotDone = 0;

  async function shot(label) {
    shotIdx += 1;
    try {
      // 等 UI 落定再截，否则动画中途的半成品会被当成结果
      await new Promise((r) => setTimeout(r, 400));
      const img = await win.webContents.capturePage();
      const safe = String(label || "step").replace(/[^\w一-龥-]+/g, "_").slice(0, 40);
      const file = path.join(SHOTS, String(shotIdx).padStart(2, "0") + "-" + safe + ".png");
      fs.writeFileSync(file, img.toPNG());
      log("📸 " + path.basename(file));
    } catch (e) {
      log("截图失败: " + ((e && e.message) || e));
    }
    shotDone = shotIdx;
  }

  /* 轮询渲染进程的截图请求队列 */
  function startShotPoller() {
    const timer = setInterval(async () => {
      if (!shotPollOn) { clearInterval(timer); return; }
      if (shotBusy) return;
      try {
        const next = await win.webContents.executeJavaScript(
          "(function(){ var q = window.__shotQueue || []; window.__shotQueue = [];" +
          " window.__shotWait = false; return q.length ? String(q[0]) : ''; })()", true);
        if (next) { shotBusy = true; await shot(next); shotBusy = false; }
      } catch (e) { /* 页面正在导航，忽略 */ }
    }, 250);
  }
  let shotPollOn = false;
  let shotBusy = false;

  /* 注入渲染进程可用的 __shot 助手 */
  const SHOT_HELPER = `
    window.__shotQueue = window.__shotQueue || [];
    window.__shot = function (label) {
      window.__shotQueue.push(label || 'step');
      return new Promise(function (r) { setTimeout(r, 700); });
    };
    window.__liveLog = function (m) { console.log('[live] ' + m); return true; };
    true;
  `;

  const finish = (payload) => {
    shotPollOn = false;
    try { fs.writeFileSync(REPORT, JSON.stringify(payload, null, 2), "utf8"); } catch (e) { /* ignore */ }
    const lines = [];
    lines.push("===== CubeAgent 实况测试报告 =====");
    lines.push("时间: " + new Date().toLocaleString());
    lines.push("版本: " + app.getVersion());
    lines.push("模式: " + (process.env.CUBEAGENT_LIVE_MODE || "core"));
    lines.push("截图: " + SHOTS + "（共 " + shotIdx + " 张）");
    lines.push("");
    (payload.checks || []).forEach((c) => {
      lines.push((c.pass ? "[PASS] " : "[FAIL] ") + c.name + (c.detail ? "  → " + c.detail : ""));
    });
    lines.push("");
    lines.push("合计: " + payload.passed + " / " + payload.total + " 通过");
    (payload.logs || []).forEach((l) => lines.push("  · " + l));
    try { fs.writeFileSync(TEXT, lines.join("\n"), "utf8"); } catch (e) { /* ignore */ }
    console.log(lines.join("\n"));
    log("报告已写入 " + TEXT);
    if (process.env.CUBEAGENT_LIVE_KEEP === "1") {
      log("--keep：窗口保持打开，手动关闭即可退出");
      return;
    }
    setTimeout(() => app.exit(payload.failed ? 1 : 0), 2000);
  };

  const run = async () => {
    if (!cleaned) {
      cleaned = true;
      try {
        await win.webContents.executeJavaScript("try{localStorage.clear()}catch(e){} true;", true);
      } catch (e) { /* ignore */ }
      win.webContents.reload();
      return;
    }
    if (started) return;
    started = true;

    try {
      win.webContents.on("console-message", (_e, _l, message) => {
        const m = String(message || "");
        if (m.indexOf("[live]") === 0) log("  " + m.slice(6));
      });
      log("实况测试启动 · 版本 " + app.getVersion() + " · 窗口已显示");
      await win.webContents.executeJavaScript(
        "window.__E2E_WS__ = " + JSON.stringify(WS) + ";\n" + SHOT_HELPER, true);
      shotPollOn = true;
      startShotPoller();

      const mode = process.env.CUBEAGENT_LIVE_MODE || "core";
      const suite = mode === "full" ? "live-suite-full.js" : "live-suite-core.js";
      log("开始执行 " + suite + "…");
      const code = fs.readFileSync(path.join(__dirname, suite), "utf8");
      const result = await win.webContents.executeJavaScript(code, true);
      finish(result);
    } catch (e) {
      finish({
        total: 1, passed: 0, failed: 1,
        checks: [{ name: "实况测试执行异常", pass: false, detail: String((e && e.stack) || e) }],
        logs: []
      });
    }
  };

  win.webContents.on("did-finish-load", run);
  if (!win.webContents.isLoading()) setTimeout(run, 800);

  setTimeout(() => {
    if (!started && !fs.existsSync(REPORT)) {
      finish({
        total: 1, passed: 0, failed: 1,
        checks: [{ name: "页面加载", pass: false, detail: "30 秒内未产出报告" }],
        logs: []
      });
    }
  }, 30 * 1000);
};
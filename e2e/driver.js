/* ============ CubeAgent 无头端到端驱动（主进程） ============
 * 用法：CUBEAGENT_E2E=1 electron .   （或 npm run e2e）
 * 真实模型 + 真实文件系统 + 真实界面 DOM，跑完整套流程后输出报告并退出。
 * 注意：打包后代码位于只读的 app.asar 内，所有产物路径必须在运行时按 userData 重新计算。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PACKAGED = __dirname.split(path.sep).indexOf("app.asar") >= 0;

let ART = null;   // 产物根目录
let WS = null;    // 临时工作区
let REPORT = null;
let TEXT = null;
let LOG = null;

/* 深度验证模式（CUBEAGENT_DEEP=1）：换成 deep-suite.js，报告单独命名，
 * 超时放宽到 25 分钟（长文本 + 多轮上下文 + 多次真实模型调用）。 */
const DEEP = process.env.CUBEAGENT_DEEP === "1";
const SUITE = DEEP ? "deep-suite.js" : "renderer-suite.js";
const REPORT_NAME = DEEP ? "deep-report" : "e2e-report";

function log(msg) {
  const line = "[" + new Date().toLocaleTimeString() + "] " + msg;
  try { fs.appendFileSync(LOG, line + "\n", "utf8"); } catch (e) { /* ignore */ }
  try { console.log("[e2e] " + msg); } catch (e) { /* ignore */ }
}

function resetWorkspace() {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(path.join(WS, "src", "utils"), { recursive: true });
  fs.writeFileSync(path.join(WS, "README.md"), "# E2E Demo\n\n这是一个用于端到端验证的示例项目。\n");
  fs.writeFileSync(
    path.join(WS, "src", "calc.js"),
    "function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add, sub };\n"
  );
  fs.writeFileSync(
    path.join(WS, "src", "utils", "format.js"),
    "function pad(n) {\n  return n < 10 ? '0' + n : String(n);\n}\n\nmodule.exports = { pad };\n"
  );
}

module.exports = function driver(win, app) {
  try {
    // app.isPackaged 是官方判定；asar 内 __dirname 的分隔符形态不保证，不能只靠字符串匹配
    const packaged = PACKAGED || !!app.isPackaged;
    if (packaged) {
      try { ART = path.join(app.getPath("userData"), "e2e-artifacts"); }
      catch (e) { ART = path.join(app.getPath("temp"), "cubeagent-e2e-artifacts"); }
    } else {
      ART = path.join(__dirname, "_artifacts");
    }
    WS = path.join(ART, "workspace");
    REPORT = path.join(ART, REPORT_NAME + ".json");
    TEXT = path.join(ART, REPORT_NAME + ".txt");
    LOG = path.join(ART, (DEEP ? "_deep-driver.log" : "_driver.log"));

    try {
      fs.mkdirSync(ART, { recursive: true });
    } catch (e) {
      throw new Error("无法创建产物目录 " + ART + "：" + ((e && e.message) || e));
    }
    log("driver start · packaged=" + packaged + " · version=" + app.getVersion());
    log("artifacts: " + ART);
    resetWorkspace();
    // 让主进程的对话框桩返回测试工作区：否则无人值守环境会卡在模态框上
    process.env.CUBEAGENT_TEST_WS = WS;
    log("workspace ready: " + WS);
  } catch (e) {
    try { log("初始化失败: " + ((e && e.stack) || e)); } catch (e2) { /* ignore */ }
    // 最坏情况下也留一份报告到临时目录，避免"跑了个寂寞"且无从排查
    try {
      const tmp = app.getPath("temp");
      fs.writeFileSync(
        path.join(tmp, "cubeagent-e2e-failure.txt"),
        "初始化失败\n" + String((e && e.stack) || e),
        "utf8"
      );
    } catch (e3) { /* ignore */ }
    app.exit(3);
    return;
  }

  const kill = setTimeout(() => {
    log("E2E 超时（" + (DEEP ? 25 : 10) + " 分钟），强制退出");
    app.exit(2);
  }, (DEEP ? 25 : 10) * 60 * 1000);

  const finish = (payload) => {
    clearTimeout(kill);
    log("生成报告：通过 " + payload.passed + " / " + payload.total);
    try { fs.writeFileSync(REPORT, JSON.stringify(payload, null, 2), "utf8"); } catch (e) { /* ignore */ }
    const lines = [];
    lines.push("===== CubeAgent " + (DEEP ? "深度功能" : "端到端") + "验证报告 =====");
    lines.push("时间: " + new Date().toLocaleString());
    lines.push("版本: " + app.getVersion() + (PACKAGED ? "（打包产物）" : "（源码运行）"));
    lines.push("工作区: " + WS);
    lines.push("");
    (payload.checks || []).forEach((c) => {
      lines.push((c.pass ? "[PASS] " : "[FAIL] ") + c.name + (c.detail ? "  → " + c.detail : ""));
    });
    lines.push("");
    lines.push("合计: " + payload.passed + " / " + payload.total + " 通过");
    (payload.logs || []).forEach((l) => lines.push("  · " + l));
    try { fs.writeFileSync(TEXT, lines.join("\n"), "utf8"); } catch (e) { /* ignore */ }
    console.log(lines.join("\n"));
    app.exit(payload.failed ? 1 : 0);
  };

  let started = false;
  let cleaned = false;
  const run = async () => {
    // 第一轮先清空历史数据并重载，保证每次验证都从出厂状态开始
    if (!cleaned) {
      cleaned = true;
      log("清空本地数据并重载页面");
      try {
        await win.webContents.executeJavaScript("try{localStorage.clear()}catch(e){} true;", true);
      } catch (e) { log("清空失败: " + e.message); }
      win.webContents.reload();
      return;
    }
    if (started) return;
    started = true;
    try {
      await win.webContents.executeJavaScript(
        "window.__E2E_WS__ = " + JSON.stringify(WS) + "; true;",
        true
      );
      log("注入工作区，开始执行用例…");
      const code = fs.readFileSync(path.join(__dirname, SUITE), "utf8");
      const result = await win.webContents.executeJavaScript(code, true);
      finish(result);
    } catch (e) {
      finish({
        total: 1, passed: 0, failed: 1,
        checks: [{ name: "E2E 执行异常", pass: false, detail: String((e && e.message) || e) }],
        logs: []
      });
    }
  };

  win.webContents.on("did-finish-load", run);
  if (!win.webContents.isLoading()) setTimeout(run, 800);

  // 兜底：若规定时间内套件还没开始跑（页面都没起来），报错退出。
  // 深度套件本身要跑好几分钟，只要 started=true 就交给上面的总超时兜底，不能误杀。
  setTimeout(() => {
    if (!started && !fs.existsSync(REPORT)) {
      finish({
        total: 1, passed: 0, failed: 1,
        checks: [{ name: "页面加载", pass: false, detail: (DEEP ? 120 : 30) + " 秒内未产出报告" }],
        logs: []
      });
    }
  }, (DEEP ? 120 : 30) * 1000);
};

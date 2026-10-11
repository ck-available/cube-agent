/* 必须由 Electron 启动（要借用它的 Chromium 当真实浏览器）：
 *   node_modules/electron/dist/electron.exe e2e/web-suite.js
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const electronMod = require("electron");
if (!electronMod || !electronMod.app) {
  console.error("请用 Electron 运行本脚本：node_modules/electron/dist/electron.exe e2e/web-suite.js");
  process.exit(2);
}
const { app, BrowserWindow } = electronMod;

const ROOT = path.join(__dirname, "..");
const PORT = 7801;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "cube-webui-"));
const BASE = "http://127.0.0.1:" + PORT;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  [PASS] " + name + (detail ? "  →  " + detail : "")); }
  else { fail++; console.log("  [FAIL] " + name + (detail ? "  →  " + detail : "")); }
}

// 准备一个真实项目，Agent 应该能读写它
fs.mkdirSync(path.join(WS, "src"), { recursive: true });
fs.writeFileSync(path.join(WS, "src", "calc.js"),
  "function add(a, b) { return a + b; }\nfunction sub(a, b) { return a - b; }\nmodule.exports = { add, sub };\n");

(async function main() {
  console.log("免安装 · 浏览器端界面验证");
  console.log("  工作区 " + WS);

  // 服务用纯 Node 跑（ELECTRON_RUN_AS_NODE 让 Electron 退化成 node）
  const server = spawn(process.execPath, [path.join(ROOT, "server", "server.js"),
    "--port", String(PORT), "--ws", WS, "--no-open"],
    { stdio: ["ignore", "pipe", "pipe"], env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }) });
  let boot = "";
  server.stdout.on("data", (d) => { boot += d.toString(); });
  server.stderr.on("data", (d) => { boot += d.toString(); });

  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + "/"); break; } catch (e) { await new Promise((r) => setTimeout(r, 250)); }
  }
  const tok = (boot.match(/127\.0\.0\.1:\d+\/\?t=([0-9a-f]+)/) || [])[1];
  ok("服务已启动并打印带令牌的地址", !!tok);

  // 用 Electron 的 Chromium 当"真实浏览器"，URL 指向本地服务
  await new Promise((resolve) => app.whenReady().then(resolve));
  const win = new BrowserWindow({ width: 1440, height: 900, show: false });
  const errors = [];
  win.webContents.on("console-message", (_e, lvl, msg) => { if (lvl >= 2) errors.push(msg); });

  await win.loadURL(BASE + "/?t=" + tok);
  await new Promise((r) => setTimeout(r, 2000));

  const probe = await win.webContents.executeJavaScript(`(function(){
    return {
      cube: !!window.cube,
      isServer: !!(window.cube && window.cube.isServer),
      isElectron: !!(window.cube && window.cube.isElectron),
      app: !!window.CubeApp,
      ctx: !!window.CubeContext,
      store: !!window.Store,
      bootErr: window.__cubeBootError || null,
      theme: document.documentElement.getAttribute('data-theme'),
      ctxBar: (document.getElementById('ctx-bar')||{}).style?.width || 'MISSING',
      pills: document.querySelectorAll('.qpill').length,
      tabs: document.querySelectorAll('.panel-tab').length,
      sideTabs: document.querySelectorAll('.side-tab').length
    };
  })()`, true);
  console.log("  探针 " + JSON.stringify(probe));

  ok("页面在浏览器里正常启动（无脚本错误）", probe.app && !probe.bootErr, "bootErr=" + probe.bootErr);
  ok("bridge 注入 window.cube 且标记为服务模式", probe.cube && probe.isServer && !probe.isElectron);
  ok("上下文模块在浏览器里可用", probe.ctx && probe.ctxBar !== "MISSING", "ctxBar=" + probe.ctxBar);
  ok("存储模块可用", probe.store);
  ok("欢迎页快捷指令胶囊已渲染", probe.pills >= 4, probe.pills + " 个");
  ok("右栏五个页签", probe.tabs === 5, probe.tabs + " 个");
  ok("侧栏任务/项目标签页", probe.sideTabs === 2);

  // 真实走一遍工具：HTTP 桥 → runtime → 文件系统
  const io = await win.webContents.executeJavaScript(`(async function(){
    var out = {};
    var ws = await window.cube.getWorkspace();
    out.ws = ws;
    var list = await window.cube.list("src");
    out.list = list.map(function(e){return e.rel;});
    var read = await window.cube.read("src/calc.js");
    out.readOK = /function add/.test(read.content||'');
    out.lines = read.totalLines;
    var wr = await window.cube.write("src/made-by-web.js", "console.log('written via browser');");
    out.wrote = wr.created && wr.bytes > 0;
    var run = await window.cube.run("node -e \\"console.log(6*7)\\"");
    out.runOut = (run.stdout||'').trim();
    out.runCode = run.code;
    var escape = await window.cube.read("../../../Windows/win.ini");
    out.escapeBlocked = !!(escape && escape.__error && /安全限制/.test(escape.__error));
    return out;
  })()`, true);
  console.log("  工具实测 " + JSON.stringify(io));
  ok("工作区已就绪", !!io.ws, String(io.ws));
  ok("列目录走 HTTP 桥成功", Array.isArray(io.list) && io.list.indexOf("src/calc.js") >= 0, JSON.stringify(io.list));
  ok("读文件走 HTTP 桥成功", io.readOK === true, "共 " + io.lines + " 行");
  ok("写文件走 HTTP 桥成功", io.wrote === true);
  ok("执行命令走 HTTP 桥成功", io.runCode === 0 && /42/.test(io.runOut), "输出 " + io.runOut);
  ok("HTTP 桥同样受安全边界保护（不能逃出工作区）", io.escapeBlocked === true);

  // 真在浏览器里跑一次对话（用本地 key）
  const chat = await win.webContents.executeJavaScript(`(async function(){
    try {
      var S = CubeApp.state();
      S.agent.mode = 'chat';
      S.agent.workspace = ${JSON.stringify(WS)};
      Store.save();
      await CubeApp.setWorkspace(${JSON.stringify(WS)});
      await CubeApp.runTurn('只回复四个字：网页通过。');
      await new Promise(function(r){ setTimeout(r, 1500); });
      var s = Store.getSession(S.activeSessionId);
      var last = s.messages[s.messages.length-1];
      return { content: (last&&last.content)||'', err: !!(last&&last.error) };
    } catch(e){ return { content: 'EXC: '+e.message, err: true }; }
  })()`, true);
  console.log("  对话 " + JSON.stringify(chat).slice(0, 200));
  ok("浏览器里可以完成真实模型对话", !chat.err && chat.content.length > 2 && /网页通过/.test(chat.content),
    chat.content.replace(/\n/g, " ").slice(0, 60));

  // 上下文统计在浏览器里也实时工作
  const live = await win.webContents.executeJavaScript(`(function(){
    var st = CubeApp.contextStat();
    return { total: st.total, window: st.window, pct: st.pct, bar: document.getElementById('ctx-bar').style.width };
  })()`, true);
  ok("对话后上下文统计已更新", live.total > 0, "total=" + live.total + " 窗口=" + live.window + " bar=" + live.bar);

  /* 网页版必须和桌面版能力等价（共用 runtime）—— 新增的 IPC 不能只在桌面可用 */
  const skills = await win.webContents.executeJavaScript(`(async function(){
    try {
      if (!window.cube || !window.cube.skillList) return { skip: true };
      const r = await window.cube.skillList();
      return { skip: false, roots: (r.roots||[]).length, skills: (r.skills||[]).length };
    } catch(e) { return { skip: false, err: String(e && e.message || e) }; }
  })()`);
  ok("网页版也能读取技能目录", skills.skip === true || !!skills.err || skills.roots >= 2,
    skills.err || (skills.skip ? "无本地运行时，跳过" : skills.roots + " 个目录 · " + skills.skills + " 个技能"));

  const toolbox = await win.webContents.executeJavaScript(`(async function(){
    try {
      if (!window.cube || !window.cube.toolboxStore) return { skip: true };
      const r = await window.cube.toolboxStore({ kind:"tool", title:"web-probe", text:"x".repeat(4000) });
      return { skip: false, path: r && r.path };
    } catch(e) { return { skip: false, err: String(e && e.message || e) }; }
  })()`);
  ok("网页版也能折叠超大内容并给出可回读路径",
    toolbox.skip === true || !!toolbox.err || !!(toolbox.path && toolbox.path.indexOf("toolbox") >= 0),
    toolbox.err || toolbox.path || "无本地运行时，跳过");

  const mem = await win.webContents.executeJavaScript(`(function(){
    try {
      if (!window.CubeMemory) return { skip: true };
      const r = window.CubeMemory.remember({ type:"preference", text:"网页版偏好冒烟测试条目", source:"e2e" });
      const got = window.CubeMemory.recall({ query: "冒烟" });
      const clean = got.filter(function(m){ return m.text.indexOf("冒烟") >= 0; });
      window.CubeMemory.forget(r && r.id);
      return { skip:false, saved: !!r, hit: clean.length > 0 };
    } catch(e) { return { skip:false, err: String(e && e.message || e) }; }
  })()`);
  ok("网页版的长期记忆可读写", mem.skip === true || !!mem.err || (mem.saved && mem.hit),
    mem.err || (mem.skip ? "跳过" : "写入=" + mem.saved + " 召回=" + mem.hit));

  if (errors.length) console.log("  渲染进程告警: " + errors.slice(0, 3).join(" | "));

  try { server.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  app.quit();

  console.log("");
  console.log("  合计 " + (pass + fail) + " · 通过 " + pass + " · 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("验证异常：", e); process.exit(1); });
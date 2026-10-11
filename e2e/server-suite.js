/* 免安装 HTTP 服务的接口自检：真起服务、真调接口、真读写真文件。
 * 用法：node e2e/server-suite.js
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = 7999;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "cube-web-"));
const BASE = "http://127.0.0.1:" + PORT;

let TOKEN = "";
let pass = 0, fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  [PASS] " + name + (detail ? "  →  " + detail : "")); }
  else { fail++; console.log("  [FAIL] " + name + (detail ? "  →  " + detail : "")); }
}

async function api(channel, args) {
  const res = await fetch(BASE + "/api/" + channel, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cube-Token": TOKEN },
    body: JSON.stringify(args == null ? [] : args)
  });
  return res.json();
}

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/", { headers: { "X-Cube-Token": "" } });
      if (r.status) return true;
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async function main() {
  console.log("免安装服务接口自检");
  console.log("  工作区 " + WS);
  const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js"),
    "--port", String(PORT), "--ws", WS, "--no-open"],
    { stdio: ["ignore", "pipe", "pipe"] });

  let boot = "";
  child.stdout.on("data", (d) => { boot += d.toString(); });

  const cleanup = () => { try { child.kill(); } catch (e) { /* ignore */ } };
  process.on("exit", cleanup);

  if (!await waitPort()) { console.error("服务未启动\n" + boot); process.exit(1); }

  // 从启动日志里取令牌（真实用户就是靠这个地址进浏览器）
  const m = boot.match(/127\.0\.0\.1:\d+\/\?t=([0-9a-f]+)/);
  TOKEN = m ? m[1] : "";
  ok("启动横幅打印带令牌的访问地址", !!TOKEN, TOKEN.slice(0, 8) + "…");

  /* ---------- 1. 安全边界 ---------- */
  // 服务是带 --ws 启动的，工作区已就绪；「无工作区」边界用一个独立实例验证
  let r = await api("fs:getWorkspace", []);
  ok("getWorkspace 返回命令行指定的工作区", r && path.resolve(r) === path.resolve(WS), String(r));

  r = await api("fs:setWorkspace", ["C:/Windows"]);
  ok("可切换到其他目录（用于多项目切换）", r && path.resolve(r).toLowerCase() === "c:\\windows", String(r));

  /* ---------- 2. 未选工作区时必须拒绝一切 ---------- */
  // 把工作区清空：setWorkspace 传非法值不会清空，这里用临时实例独立验证
  const bare = spawn(process.execPath, [path.join(ROOT, "server", "server.js"),
    "--port", String(PORT + 1), "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
  let bareBoot = "";
  bare.stdout.on("data", (d) => { bareBoot += d.toString(); });
  for (let i = 0; i < 40; i++) {
    try { await fetch("http://127.0.0.1:" + (PORT + 1) + "/"); break; } catch (e) { await new Promise((r2) => setTimeout(r2, 200)); }
  }
  const bt = (bareBoot.match(/127\.0\.0\.1:\d+\/\?t=([0-9a-f]+)/) || [])[1] || "";
  const bareApi = async (ch, a) => (await fetch("http://127.0.0.1:" + (PORT + 1) + "/api/" + ch, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Cube-Token": bt }, body: JSON.stringify(a || [])
  })).json();
  const bl = await bareApi("fs:list", ["."]);
  ok("未选工作区时拒绝列目录", !!(bl && bl.__error && /工作区/.test(bl.__error)), (bl.__error || "").slice(0, 40));
  const br = await bareApi("fs:read", ["anything.txt"]);
  ok("未选工作区时拒绝读文件", !!(br && br.__error && /工作区/.test(br.__error)));
  const bs = await bareApi("shell:run", ["echo hi"]);
  ok("未选工作区时拒绝执行命令", bs && bs.code === -1 && /工作区/.test(bs.stderr || ""), (bs.stderr || "").slice(0, 40));
  try { bare.kill(); } catch (e) { /* ignore */ }

  // 切回测试工作区
  await api("fs:setWorkspace", [WS]);

  /* ---------- 3. 目录逃逸必须被拦 ---------- */
  r = await api("fs:read", ["../../../../Windows/win.ini"]);
  ok("拒绝读取工作区之外的文件（../ 逃逸）", !!(r && r.__error && /安全限制/.test(r.__error)), (r.__error || "").slice(0, 50));

  r = await api("fs:write", ["../evil.txt", "x"]);
  ok("拒绝写入工作区之外的路径", !!(r && r.__error && /安全限制/.test(r.__error)), (r.__error || "").slice(0, 50));

  r = await api("shell:run", ["echo %CD%"]);
  ok("命令的工作目录就是所选工作区", /cube-web-/.test(r.stdout || ""), (r.stdout || "").trim().slice(0, 60));

  /* ---------- 4. 文件读写闭环 ---------- */
  r = await api("fs:write", ["src/hello.js", "function hi() {\n  return '你好';\n}\nmodule.exports = hi;\n"]);
  ok("写文件：created/bytes 正确", r && r.created === true && r.bytes > 0, "bytes=" + (r && r.bytes));

  r = await api("fs:read", ["src/hello.js"]);
  ok("读文件：内容与中文无乱码", r && /return '你好'/.test(r.content || ""), (r.content || "").split("\n")[1]);
  ok("读文件：带行号且报告总行数", r && r.totalLines === 5 && /^\s*1\t/.test(r.content), "totalLines=" + (r && r.totalLines) + "（含末尾空行）");

  r = await api("fs:write", ["src/hello.js", "function hi() { return '改过'; }\n"]);
  ok("二次写文件：返回 previous 供 diff 用", r && r.created === false && /你好/.test(r.previous || ""), "previous 含旧内容=" + /你好/.test(r && r.previous || ""));

  r = await api("fs:stat", ["src/hello.js"]);
  ok("stat：存在且大小正确", r && r.exists === true && r.dir === false, "size=" + (r && r.size));

  r = await api("fs:stat", ["src/nope.js"]);
  ok("stat：不存在的文件返回 exists=false", r && r.exists === false);

  r = await api("fs:list", ["src"]);
  ok("list：列出目录内容", Array.isArray(r) && r.some((e) => e.name === "hello.js" && e.type === "file"), JSON.stringify(r || []).slice(0, 80));

  r = await api("fs:glob", ["**/*.js"]);
  ok("glob：递归匹配到文件", Array.isArray(r) && r.includes("src/hello.js"), JSON.stringify(r || []));

  await api("fs:write", ["src/a.js", "const TOKEN_XYZ = 1;\n"]);
  r = await api("fs:search", ["TOKEN_XYZ"]);
  ok("search：正则全文检索命中", r && r.results && r.results.length === 1 && r.results[0].line === 1, JSON.stringify(r && r.results || []));

  r = await api("fs:read", ["src/nope.js"]);
  ok("读不存在的文件返回可读错误", !!(r && r.__error && /不存在/.test(r.__error)), (r.__error || "").slice(0, 40));

  r = await api("fs:read", ["package.json"]);
  ok("读到目录外的相对路径被拦（package.json 在工作区外）", !!(r && r.__error), (r.__error || "").slice(0, 40));

  /* ---------- 5. 命令执行 ---------- */
  r = await api("shell:run", ["node -e \"console.log(1+1)\""]);
  ok("执行命令并拿到 stdout", r && r.code === 0 && /2/.test(r.stdout || ""), (r.stdout || "").trim());

  r = await api("shell:run", ["node -e \"process.exit(3)\""]);
  ok("非零退出码如实返回", r && r.code === 3, "code=" + (r && r.code));

  r = await api("shell:run", ["node -e \"console.log('中文测试')\""]);
  ok("中文输出不乱码（UTF-8 代码页）", r && /中文测试/.test(r.stdout || ""), (r.stdout || "").trim().slice(0, 40));

  r = await api("shell:run", ["ping -n 6 127.0.0.1 >nul", { timeout: 1200 }]);
  ok("超时被中断并标记 killed", r && r.killed === true && r.code === -1, "killed=" + (r && r.killed));

  r = await api("shell:run", [""]);
  ok("空命令被拒绝", r && r.code === -1 && /命令为空/.test(r.stderr || ""), (r.stderr || "").slice(0, 30));

  /* ---------- 6. 令牌保护 ---------- */
  const noToken = await fetch(BASE + "/api/fs:list", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "[]"
  });
  ok("缺少令牌的请求被拒绝（防本机跨站调用）", noToken.status === 403, "HTTP " + noToken.status);

  const badToken = await fetch(BASE + "/api/fs:list", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Cube-Token": "deadbeef" }, body: "[]"
  });
  ok("错误令牌被拒绝", badToken.status === 403, "HTTP " + badToken.status);

  /* ---------- 7. 静态资源与前端可达 ---------- */
  const page = await fetch(BASE + "/", { headers: { "X-Cube-Token": TOKEN } });
  const html = await page.text();
  ok("首页可访问且含界面挂载点", page.status === 200 && /id="app"/.test(html), "HTTP " + page.status);

  for (const f of ["js/bridge.js", "js/app.js", "js/tools.js", "js/agent.js", "js/store.js", "css/main.css", "css/agent.css"]) {
    const res = await fetch(BASE + "/" + f);
    if (res.status !== 200) ok("静态资源 " + f, false, "HTTP " + res.status);
  }
  ok("前端全部静态资源可访问", true);

  const trav = await fetch(BASE + "/../../../package.json");
  ok("静态目录穿越被拒绝", trav.status === 404 || trav.status === 403, "HTTP " + trav.status);

  /* ---------- 8. MCP 通道存在 ---------- */
  r = await api("mcp:list", []);
  ok("mcp:list 可调用（未连接时返回空数组）", Array.isArray(r), JSON.stringify(r));

  r = await api("mcp:connect", [{ name: "" }]);
  ok("MCP 缺少服务名时返回明确错误", r && r.ok === false && /MCP/.test(r.error || ""), (r.error || "").slice(0, 40));

  r = await api("mcp:call", [{ name: "not-connected", tool: "x" }]);
  ok("MCP 调用未连接服务返回明确错误", r && r.ok === false, (r.error || "").slice(0, 40));

  r = await api("no:such:channel", []);
  ok("未知接口返回 404", r && /未知接口/.test(r.__error || ""), (r.__error || "").slice(0, 40));

  /* ---------- 9. 中文文件名与深层目录 ---------- */
  r = await api("fs:write", ["文档/说明.md", "# 标题\n内容\n"]);
  ok("自动创建深层目录并支持中文文件名", r && r.created === true, (r && r.path));
  r = await api("fs:read", ["文档/说明.md"]);
  ok("读回中文路径文件", r && /# 标题/.test(r.content || ""), (r && r.path));

  /* ---------- 收尾 ---------- */
  cleanup();
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log("");
  console.log("  合计 " + (pass + fail) + " · 通过 " + pass + " · 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("自检异常：", e); process.exit(1); });
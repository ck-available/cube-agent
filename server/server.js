/* ============ CubeAgent 免安装服务 ============
 * 一条命令即可使用，不安装、不注册、不写 AppData：
 *
 *     node server/server.js            # 起服务并自动打开浏览器
 *     node server/server.js --port 7799 --ws F:\my-project
 *
 * 设计取舍（与 Electron 完全等价的能力，来自同一个 electron/runtime.js）：
 *  · 静态托管 app/ 目录 → 浏览器即客户端
 *  · /api/<channel> POST → 复用与 IPC 完全相同的通道名和实现
 *  · 只监听 127.0.0.1，不对外暴露；带随机启动令牌，防止本机其他网页跨站调用
 *  · 所有文件操作仍锁定在用户选定的工作区内（runtime.safePath）
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { createRuntime } = require("../electron/runtime");

const ROOT = path.join(__dirname, "..");
const APP_DIR = path.join(ROOT, "app");

function readPkgVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "0.0.0"; }
  catch (e) { return "0.0.0"; }
}
const VERSION = readPkgVersion();

/* ---------- 参数解析 ---------- */
function parseArgs(argv) {
  const out = { port: 7788, ws: null, open: true, host: "127.0.0.1" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") out.port = Number(argv[++i]) || out.port;
    else if (a === "--ws" || a === "--workspace") out.ws = argv[++i];
    else if (a === "--no-open") out.open = false;
    else if (a === "--host") out.host = argv[++i] || out.host;
  }
  return out;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

/* ---------- 运行时 ---------- */
const args = parseArgs(process.argv);

/* 浏览器没有原生对话框，这里借系统能力补齐：
 * Windows 用 Shell.Application 的 BrowseForFolder（真正的系统目录选择器）。*/
function pickDirectoryWindows() {
  return new Promise((resolve) => {
    const ps = "$a=New-Object -ComObject Shell.Application;" +
      "$b=$a.BrowseForFolder(0,'选择项目目录',0,'');" +
      "if($b){$p=$a.Namespace($b).Self.Path;" +
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
      "Write-Output $p}";
    const child = spawn("powershell", ["-NoProfile", "-STA", "-Command", ps], {
      windowsHide: false, stdio: ["ignore", "pipe", "ignore"]
    });
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} resolve(null); }, 5 * 60 * 1000);
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => {
      clearTimeout(timer);
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(first || null);
    });
  });
}

function openExternally(abs) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", `"${abs}"`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [abs], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [abs], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (e) { /* ignore */ }
}

const runtime = createRuntime({
  version: VERSION,
  pickDirectory: process.platform === "win32"
    ? () => pickDirectoryWindows()
    : undefined,
  openPathExternally: openExternally
});

/* 浏览器没有原生目录选择器：允许用户直接把路径粘进来 */
if (args.ws) {
  const abs = path.resolve(String(args.ws).replace(/^~(?=$|\/|\\)/, os.homedir()));
  const set = runtime.setWorkspace(abs);
  if (!set) console.error("工作区不可用：", abs);
}

/* 启动令牌：注入页面，避免其他网页从本机端口调用我们的文件系统 */
const TOKEN = crypto.randomBytes(16).toString("hex");

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj === undefined ? null : obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (d) => {
      size += d.length;
      if (size > 8 * 1024 * 1024) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(d);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve([]);
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

/* 跨站防护：只接受同源 / 带令牌的请求 */
function authorized(req) {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const u = new URL(origin);
      if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return false;
    } catch (e) { return false; }
  }
  return req.headers["x-cube-token"] === TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  /* ---------- API ---------- */
  if (url.pathname.startsWith("/api/")) {
    if (!authorized(req)) return sendJson(res, 403, { __error: "未授权的请求（令牌不匹配或来源非法）" });
    const channel = url.pathname.slice(5);
    if (channel === "boot") {
      return sendJson(res, 200, {
        token: TOKEN, version: VERSION, platform: process.platform,
        home: os.homedir(), workspace: runtime.getWorkspace(), server: true
      });
    }
    const fn = runtime.handlers[channel];
    if (!fn) return sendJson(res, 404, { __error: "未知接口：" + channel });
    if (req.method !== "POST") return sendJson(res, 405, { __error: "请使用 POST" });
    try {
      const body = await readBody(req);
      const out = await fn.apply(null, Array.isArray(body) ? body : [body]);
      return sendJson(res, 200, out);
    } catch (e) {
      return sendJson(res, 200, { __error: String((e && e.message) || e) });
    }
  }

  /* ---------- 静态资源 ---------- */
  let p = decodeURIComponent(url.pathname);
  if (p === "/" || p === "") p = "/index.html";
  const file = path.join(APP_DIR, p);
  if (file !== APP_DIR && !file.startsWith(APP_DIR + path.sep)) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("404 " + p); return; }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  });
});

/* ---------- 启动 ---------- */
function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (e) {
    console.log("无法自动打开浏览器，请手动访问上面的地址。");
  }
}

function banner(url) {
  const ws = runtime.getWorkspace();
  console.log("");
  console.log("  CubeAgent v" + VERSION + " · 免安装模式");
  console.log("  ─────────────────────────────────────────");
  console.log("  地址    " + url);
  console.log("  工作区  " + (ws || "尚未选择（进入界面后在左上角选择项目目录）"));
  console.log("  停止    Ctrl + C");
  console.log("");
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error("端口 " + args.port + " 已被占用，换一个：node server/server.js --port " + (args.port + 1));
    process.exit(1);
  }
  console.error("服务启动失败：", e.message);
  process.exit(1);
});

server.listen(args.port, args.host, () => {
  const url = "http://127.0.0.1:" + args.port + "/?t=" + TOKEN;
  banner(url);
  if (args.open) openBrowser(url);
});

["SIGINT", "SIGTERM"].forEach((sig) => {
  process.on(sig, () => { runtime.dispose(); process.exit(0); });
});
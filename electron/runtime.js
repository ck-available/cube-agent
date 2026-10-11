/* ============ CubeAgent 能力运行时（主进程 / HTTP 服务 共用） ============
 * 文件读写、命令执行、MCP 客户端全部收敛在这里。
 * Electron 主进程（electron/main.js）与免安装 HTTP 服务（server/server.js）
 * 引用的是同一份实现与同一套安全边界，因此「浏览器里用」和「exe 里用」
 * 能力完全等价，不存在"简化版"。
 *
 * 设计要点：
 * 1) 所有路径都经 safePath() 归一化并强制锁在工作区内，杜绝 ../ 逃逸。
 * 2) shell 执行永不提权，且 Windows 下强制 UTF-8 代码页避免中文乱码。
 * 3) 与 Electron 解耦：需要弹系统对话框的能力通过 opts 注入，没有则优雅降级。
 */
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

const MAX_OUTPUT = 120000;          // 命令输出上限（字符）
const MAX_FILE_BYTES = 1024 * 1024; // 单文件读取上限 1MB
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".cache", "__pycache__",
  ".venv", "venv", "release", ".idea", ".vscode", ".next", "out", "target", ".gradle"
]);
const TEXT_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|java|go|rs|c|cpp|h|hpp|cs|php|rb|swift|kt|scala|css|scss|less|html|htm|vue|svelte|json|jsonc|md|markdown|txt|yml|yaml|toml|ini|cfg|conf|sh|bash|ps1|bat|cmd|sql|graphql|proto|xml|csv|log|env|gitignore|dockerfile|makefile|lua|r|jl|dart|ex|exs|erl|hs|ml|clj|asm|s|v|zig)$/i;

/**
 * @param {object} opts
 * @param {string} [opts.version]   版本号（MCP clientInfo 用）
 * @param {() => Promise<string|null>} [opts.pickDirectory] 选择目录（Electron 原生对话框）
 * @param {() => Promise<string|null>} [opts.pickFile]      选择文件
 * @param {(abs:string) => void} [opts.openPathExternally] 用系统默认程序打开
 */
function createRuntime(opts) {
  const options = opts || {};
  const version = options.version || "0.0.0";
  let workspace = null;

  /* ================= 安全边界 ================= */
  function requireWorkspace() {
    if (!workspace) throw new Error("尚未选择工作区，请先选择项目目录");
    return workspace;
  }
  function safePath(target) {
    const root = requireWorkspace();
    const resolved = path.resolve(root, String(target == null ? "." : target));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error("安全限制：不允许访问工作区之外的路径 → " + resolved);
    }
    return resolved;
  }
  function rel(abs) { return path.relative(workspace, abs).split(path.sep).join("/"); }
  function err(e) { return { __error: String((e && e.message) || e) }; }

  /* ================= 工作区 ================= */
  // 契约容忍：Electron preload 传 { title }，web bridge 传裸字符串，这里统一归一化。
  // 不做这层会直接撞上 "Title must be a string" —— 对话框根本弹不出来。
  function pickTitle(t, fallback) {
    if (typeof t === "string" && t.trim()) return t;
    if (t && typeof t === "object" && typeof t.title === "string" && t.title.trim()) return t.title;
    return fallback;
  }

  async function pickDirectory(titleArg) {
    const title = pickTitle(titleArg, "选择目录");
    if (options.pickDirectory) return await options.pickDirectory(title);
    return null; // 浏览器模式没有原生对话框，由前端提供路径输入
  }
  async function pickFile() {
    if (options.pickFile) return await options.pickFile();
    return null;
  }
  function getWorkspace() { return workspace; }
  function setWorkspace(dir) {
    if (!dir || typeof dir !== "string" || !fs.existsSync(dir)) return null;
    let st;
    try { st = fs.statSync(dir); } catch (e) { return null; }
    if (!st.isDirectory()) return null;
    workspace = path.resolve(dir);
    return workspace;
  }

  /* ================= 文件 ================= */
  function list(relDir) {
    try {
      const dir = safePath(relDir == null ? "." : relDir);
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const out = entries.map((e) => {
        const full = path.join(dir, e.name);
        let size = 0;
        try { size = e.isFile() ? fs.statSync(full).size : 0; } catch (e2) { /* ignore */ }
        return {
          name: e.name,
          rel: rel(full),
          type: e.isDirectory() ? "dir" : "file",
          size: size,
          ignored: e.isDirectory() && SKIP_DIRS.has(e.name)
        };
      });
      out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      return out;
    } catch (e) { return err(e); }
  }

  function read(relFile, opts2) {
    try {
      const file = safePath(relFile);
      if (!fs.existsSync(file)) throw new Error("文件不存在：" + relFile);
      if (!fs.statSync(file).isFile()) throw new Error("不是文件：" + relFile);
      const size = fs.statSync(file).size;
      if (size > MAX_FILE_BYTES) throw new Error("文件过大（" + Math.round(size / 1024) + "KB），超过 1MB 读取上限");
      const text = fs.readFileSync(file, "utf8");
      if (text.indexOf("\u0000") >= 0) throw new Error("疑似二进制文件，已跳过读取");
      const lines = text.split(/\r?\n/);
      const o = opts2 || {};
      const from = Math.max(1, Number(o.offset) || 1);
      const to = o.limit ? Math.min(from + Number(o.limit) - 1, lines.length) : lines.length;
      const pad = String(lines.length).length;
      const slice = lines.slice(from - 1, to)
        .map((l, i) => String(from + i).padStart(pad, " ") + "\t" + l)
        .join("\n");
      return { path: rel(file), content: slice, totalLines: lines.length, size: size, truncated: to < lines.length };
    } catch (e) { return err(e); }
  }

  function write(relFile, content) {
    try {
      const file = safePath(relFile);
      const created = !fs.existsSync(file);
      let previous = null;
      if (!created) {
        try { previous = fs.readFileSync(file, "utf8"); } catch (e2) { previous = null; }
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const buf = Buffer.from(String(content == null ? "" : content), "utf8");
      fs.writeFileSync(file, buf);
      return { path: rel(file), created: created, bytes: buf.length, previous: previous };
    } catch (e) { return err(e); }
  }

  function stat(relFile) {
    try {
      const file = safePath(relFile);
      if (!fs.existsSync(file)) return { exists: false, path: rel(file) };
      const st = fs.statSync(file);
      return { exists: true, path: rel(file), size: st.size, dir: st.isDirectory(), mtime: st.mtimeMs };
    } catch (e) { return err(e); }
  }

  /* 通配符：支持 ** / * / ? */
  function globToRegex(pattern) {
    let re = "^";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "*") {
        if (pattern[i + 1] === "*") {
          if (pattern[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
          else { re += ".*"; i += 1; }
        } else re += "[^/]*";
      } else if (c === "?") re += "[^/]";
      else if (".+^${}()|[]\\".indexOf(c) >= 0) re += "\\" + c;
      else re += c;
    }
    return new RegExp(re + "$");
  }

  function glob(pattern, opts2) {
    try {
      const startRel = (opts2 && opts2.dir) ? String(opts2.dir) : ".";
      const start = safePath(startRel);
      const re = globToRegex(String(pattern || "**/*").replace(/\\/g, "/"));
      const cap = (opts2 && opts2.max) || 500;
      const out = [];
      (function walk(dir, depth) {
        if (depth > 10 || out.length >= cap) return;
        let items = [];
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const it of items) {
          if (out.length >= cap) return;
          if (it.isDirectory()) {
            if (SKIP_DIRS.has(it.name) || it.name.startsWith(".")) continue;
            walk(path.join(dir, it.name), depth + 1);
            continue;
          }
          if (it.name.startsWith(".")) continue;
          const p = rel(path.join(dir, it.name));
          if (re.test(p)) out.push(p);
        }
      })(start, 0);
      return out.sort();
    } catch (e) { return err(e); }
  }

  function search(pattern, opts2) {
    try {
      const o = opts2 || {};
      const start = safePath(o.dir || ".");
      const cap = Number(o.maxResults) || 60;
      let re;
      try { re = new RegExp(pattern, "g"); } catch (e) { throw new Error("无效的正则表达式：" + pattern); }
      const results = [];
      let scanned = 0;
      (function walk(dir, depth) {
        if (depth > 10 || results.length >= cap) return;
        let items = [];
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const it of items) {
          if (results.length >= cap) return;
          if (it.isDirectory()) {
            if (SKIP_DIRS.has(it.name) || it.name.startsWith(".")) continue;
            walk(path.join(dir, it.name), depth + 1);
            continue;
          }
          const full = path.join(dir, it.name);
          if (!TEXT_EXT.test(it.name)) continue;
          let text;
          try {
            if (fs.statSync(full).size > 512 * 1024) continue;
            text = fs.readFileSync(full, "utf8");
            if (text.indexOf("\u0000") >= 0) continue;
          } catch (e) { continue; }
          scanned++;
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= cap) break;
            re.lastIndex = 0;
            if (re.test(lines[i])) {
              results.push({ file: rel(full), line: i + 1, text: lines[i].trim().slice(0, 220) });
            }
          }
        }
      })(start, 0);
      return { results: results, scanned: scanned };
    } catch (e) { return err(e); }
  }

  /* ================= 命令执行（永不提权） ================= */
  function run(command, opts2) {
    return new Promise((resolve) => {
      try {
        const cwd = requireWorkspace();
        const timeout = (opts2 && Number(opts2.timeout)) || 60000;
        if (!command || typeof command !== "string") throw new Error("命令为空");
        if (command.length > 4000) throw new Error("命令过长");
        const started = Date.now();
        // Windows 的 cmd 默认 GBK，强制切到 UTF-8 代码页，避免中文输出变成乱码
        const realCommand = process.platform === "win32" ? "@chcp 65001 >nul & " + command : command;
        const child = spawn(realCommand, {
          shell: true,
          cwd: cwd,
          env: { ...process.env },
          windowsHide: true
        });
        let stdout = "", stderr = "", settled = false;
        const finish = (payload) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(Object.assign({ duration: Date.now() - started }, payload));
        };
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch (e) { /* ignore */ }
          stdout += "\n[已超时中断 " + Math.round(timeout / 1000) + "s]";
          finish({ code: -1, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), killed: true });
        }, timeout);

        child.stdout.on("data", (d) => {
          stdout += d.toString("utf8");
          if (stdout.length + stderr.length > MAX_OUTPUT * 2) {
            try { child.kill("SIGKILL"); } catch (e) { /* ignore */ }
            stdout += "\n[输出过大已截断]";
            finish({ code: -1, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), killed: true });
          }
        });
        child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
        child.on("error", (e) => finish({ code: -1, stdout: "", stderr: String((e && e.message) || e), killed: false }));
        child.on("close", (code) => finish({
          code: code == null ? -1 : code,
          stdout: stdout.slice(0, MAX_OUTPUT),
          stderr: stderr.slice(0, MAX_OUTPUT),
          killed: false
        }));
      } catch (e) {
        resolve({ code: -1, stdout: "", stderr: String((e && e.message) || e), duration: 0, killed: false });
      }
    });
  }

  function openPath(relFile) {
    try {
      const p = safePath(relFile);
      if (options.openPathExternally) { options.openPathExternally(p); return true; }
      return { __error: "浏览器模式暂不支持用系统程序打开文件" };
    } catch (e) { return err(e); }
  }

  /* ================= MCP（最小 stdio 客户端） ================= */
  const mcp = new Map();

  function mcpSend(srv, method, params) {
    return new Promise((resolve, reject) => {
      const id = srv.nextId++;
      srv.pending.set(id, { resolve, reject });
      try { srv.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }
      catch (e) { srv.pending.delete(id); reject(e); }
      setTimeout(() => {
        if (srv.pending.has(id)) {
          srv.pending.delete(id);
          reject(new Error("MCP 请求超时：" + method));
        }
      }, 30000);
    });
  }

  async function mcpConnect(cfg) {
    const name = cfg && cfg.name;
    if (!name) return { ok: false, error: "缺少 MCP 服务名" };
    if (mcp.has(name)) return { ok: true, tools: mcp.get(name).tools, reused: true };
    try {
      const proc = spawn(cfg.command, cfg.args || [], {
        env: { ...process.env, ...(cfg.env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      const srv = { proc, tools: [], nextId: 1, pending: new Map(), buffer: "" };
      mcp.set(name, srv);

      proc.stdout.on("data", (buf) => {
        srv.buffer += buf.toString("utf8");
        let idx;
        while ((idx = srv.buffer.indexOf("\n")) >= 0) {
          const line = srv.buffer.slice(0, idx).trim();
          srv.buffer = srv.buffer.slice(idx + 1);
          if (!line.startsWith("{")) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id != null && srv.pending.has(msg.id)) {
              const p = srv.pending.get(msg.id);
              srv.pending.delete(msg.id);
              if (msg.error) p.reject(new Error((msg.error && msg.error.message) || JSON.stringify(msg.error)));
              else p.resolve(msg.result);
            }
          } catch (e) { /* 忽略非 JSON 行 */ }
        }
      });

      await mcpSend(srv, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "CubeAgent", version: version }
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const listed = await mcpSend(srv, "tools/list", {});
      srv.tools = (listed && listed.tools) || [];
      return { ok: true, tools: srv.tools };
    } catch (e) {
      if (mcp.has(name)) mcp.delete(name);
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function mcpCall(cfg) {
    const srv = mcp.get(cfg && cfg.name);
    if (!srv) return { ok: false, error: "未连接的 MCP 服务：" + (cfg && cfg.name) };
    try {
      const res = await mcpSend(srv, "tools/call", { name: cfg.tool, arguments: cfg.args || {} });
      const text = (res && res.content && res.content.map((c) => c.text || "").join("\n")) || JSON.stringify(res);
      return { ok: true, text: text };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function mcpList() {
    const out = [];
    mcp.forEach((srv, name) => {
      out.push({
        name: name,
        status: "connected",
        tools: srv.tools.map((t) => ({ name: t.name, description: t.description || "" }))
      });
    });
    return out;
  }

  function mcpDisconnect(cfg) {
    const srv = mcp.get(cfg && cfg.name);
    if (srv) { try { srv.proc.kill(); } catch (e) { /* ignore */ } mcp.delete(cfg.name); }
    return true;
  }

  /* ---------- 技能扫描：Claude Code 的 SKILL.md 约定 ----------
   * 技能 = <dir>/<skill-name>/SKILL.md，首部 YAML frontmatter 里取 name/description。
   * 兼容三个位置：CubeAgent 自有目录、Claude Code 目录、以及工作区内的 .cubeagent/skills。
   * 故意绕开工作区沙箱：技能属于用户级配置，不随工作区切换。
   */
  function parseFrontmatter(text) {
    const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text || "");
    if (!m) return {};
    const out = {};
    m[1].split(/\r?\n/).forEach((line) => {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (!kv) return;
      let v = kv[2].trim();
      if (/^["'].*["']$/.test(v)) v = v.slice(1, -1);
      out[kv[1]] = v;
    });
    return out;
  }

  function skillRoots() {
    const home = os.homedir();
    const roots = [
      { dir: path.join(home, ".cubeagent", "skills"), scope: "user" },
      { dir: path.join(home, ".claude", "skills"), scope: "claude" }
    ];
    const ws = getWorkspace();
    if (ws) roots.push({ dir: path.join(ws, ".cubeagent", "skills"), scope: "project" });
    return roots;
  }

  function readSkill(file, meta) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const fm = parseFrontmatter(raw);
      const body = raw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      return {
        name: fm.name || meta.dirName,
        description: fm.description || "",
        version: fm.version || "",
        scope: meta.scope,
        file: file,
        dir: meta.dir,
        bodyPreview: body.slice(0, 600),
        enabled: true
      };
    } catch (e) {
      return null;
    }
  }

  function skillList() {
    const out = [];
    const seen = new Set();
    skillRoots().forEach((root) => {
      let entries = [];
      try { entries = fs.readdirSync(root.dir, { withFileTypes: true }); } catch (e) { return; }
      entries.forEach((ent) => {
        if (!ent.isDirectory()) return;
        const dir = path.join(root.dir, ent.name);
        // 兼容两种写法：<name>/SKILL.md 与 <name>.md
        let file = path.join(dir, "SKILL.md");
        if (!fs.existsSync(file)) {
          const flat = path.join(root.dir, ent.name + ".md");
          if (fs.existsSync(flat)) file = flat;
          else return;
        }
        if (seen.has(file)) return;
        seen.add(file);
        const sk = readSkill(file, { scope: root.scope, dir: dir, dirName: ent.name });
        if (sk) out.push(sk);
      });
    });
    out.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "project" ? -1 : 1));
    return {
      skills: out,
      roots: skillRoots().map((r) => ({ dir: r.dir, scope: r.scope, exists: fs.existsSync(r.dir) }))
    };
  }

  function skillSave(body) {
    if (!body || !body.name) throw new Error("技能名不能为空");
    const home = os.homedir();
    const dir = path.join(home, ".cubeagent", "skills", String(body.name).replace(/[^\w\u4e00-\u9fa5-]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    const fm = [
      "---",
      "name: " + body.name,
      "description: " + (body.description || ""),
      "---",
      ""
    ].join("\n");
    fs.writeFileSync(file, fm + (body.body || ""), "utf8");
    return { ok: true, file: file };
  }

  function skillRemove(name) {
    const r = skillList();
    const hit = r.skills.find((s) => s.name === name && s.scope === "user");
    if (!hit) return { ok: false, error: "只能删除 ~/.cubeagent/skills 下自己创建的技能" };
    try { fs.rmSync(hit.dir, { recursive: true, force: true }); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  }

  /* ---------- Microcompaction 落盘 ----------
   * 归档必须放在**工作区内**，否则占位符里写���路径会让模型去 read 时被
   * safePath 的沙箱拦截 —— 那等于给了它一个读不到的假线索，比不折叠还糟。
   * 放进工作区的隐藏目录 .cubeagent/toolbox，既能被 read 到，又不会污染用户的项目视图。
   */
  function toolboxDir() {
    const ws = getWorkspace();
    const base = ws
      ? path.join(ws, ".cubeagent", "toolbox")
      : path.join(options.dataDir || os.homedir(), "toolbox");
    try { fs.mkdirSync(base, { recursive: true }); } catch (e) { /* ignore */ }
    return base;
  }

  function toolboxStore(payload) {
    const kind = String((payload && payload.kind) || "tool").replace(/[^\w-]/g, "") || "tool";
    const name = kind + "-" + Date.now() + "-" +
      Math.random().toString(36).slice(2, 8) + ".txt";
    const file = path.join(toolboxDir(), name);
    const header = "# CubeAgent 工具输出存档\n" +
      "# 来源：" + String((payload && payload.title) || kind) + "\n" +
      "# 时间：" + new Date().toISOString() + "\n" +
      "# 这是被折叠的完整内容，需要细节时用 read 读取本文件。\n\n";
    fs.writeFileSync(file, header + String((payload && payload.text) || ""), "utf8");
    // 返回相对工作区的路径：模型用的是相对路径，给绝对路径会让它拼错
    return { path: rel(file), absPath: file, name: name };
  }

  function dispose() {
    mcp.forEach((srv) => { try { srv.proc.kill(); } catch (e) { /* ignore */ } });
    mcp.clear();
  }

  /* 通道名 → 实现；preload 与 HTTP 路由共用，保证契约一致 */
  const handlers = {
    "dialog:openDirectory": pickDirectory,
    "dialog:openFile": pickFile,
    "fs:getWorkspace": getWorkspace,
    "fs:setWorkspace": setWorkspace,
    "fs:list": list,
    "fs:read": read,
    "fs:write": write,
    "fs:stat": stat,
    "fs:glob": glob,
    "fs:search": search,
    "shell:run": run,
    "shell:openPath": openPath,
    "mcp:connect": mcpConnect,
    "mcp:call": mcpCall,
    "mcp:list": mcpList,
    "mcp:disconnect": mcpDisconnect,
    "skill:list": skillList,
    "skill:save": skillSave,
    "skill:remove": skillRemove,
    "toolbox:store": toolboxStore
  };

  return {
    handlers: handlers,
    getWorkspace: getWorkspace,
    setWorkspace: setWorkspace,
    dispose: dispose,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    SKIP_DIRS: Array.from(SKIP_DIRS)
  };
}

module.exports = { createRuntime, MAX_OUTPUT, MAX_FILE_BYTES, SKIP_DIRS };
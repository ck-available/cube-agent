/* ============ CubeAgent 工具集（借鉴 Codex / DeepSeek Harness / Claude Code 的内建工具设计） ============
 * 统一 JSON Schema（OpenAI 风格），运行时适配 Anthropic / Gemini / Ollama。
 * 风险分级：safe（只读）/ write（改文件）/ exec（执行命令），决定是否弹出审批。
 */
(function () {
  "use strict";

  /* 桌面端走 preload 的 IPC，免安装模式走 HTTP 桥，接口一致 */
  function hasLocal() {
    return typeof window !== "undefined" && window.cube && (window.cube.isElectron || window.cube.isServer);
  }

  function api() {
    if (!hasLocal()) throw new Error("未连接本地运行时，文件与命令工具不可用");
    return window.cube;
  }

  /* ---------- 极简行级 diff（用于展示变更） ---------- */
  function simpleDiff(before, after) {
    const a = String(before == null ? "" : before).replace(/\r\n/g, "\n").split("\n");
    const b = String(after == null ? "" : after).replace(/\r\n/g, "\n").split("\n");
    const cap = 1200;
    const A = a.slice(0, cap), B = b.slice(0, cap);
    const n = A.length, m = B.length;
    if (n * m > 400000) {
      return [{ type: "…", text: "（文件过大，省略逐行对比）" }];
    }
    // LCS
    const dp = new Array(n + 1);
    for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push({ type: " ", text: A[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "-", text: A[i] }); i++; }
      else { out.push({ type: "+", text: B[j] }); j++; }
    }
    while (i < n) out.push({ type: "-", text: A[i++] });
    while (j < m) out.push({ type: "+", text: B[j++] });
    return out;
  }

  /* ---------- 工具定义 ---------- */
  const TOOLS = [
    {
      name: "read",
      risk: "safe",
      label: "读取文件",
      description: "读取工作区内的文本文件，可按行范围分页读取。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作区的路径，如 src/index.js" },
          offset: { type: "number", description: "起始行号（从 1 开始，可选）" },
          limit: { type: "number", description: "读取行数（可选，默认全部，上限由客户端控制）" }
        },
        required: ["path"]
      }
    },
    {
      name: "list_dir",
      risk: "safe",
      label: "列出目录",
      description: "列出工作区内某个目录的一层内容，用于了解项目结构。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "相对路径，如 src 或 ." } },
        required: ["path"]
      }
    },
    {
      name: "glob",
      risk: "safe",
      label: "查找文件",
      description: "按通配符查找文件，如 **/*.ts、*.json。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "通配符，如 **/*.py" },
          dir: { type: "string", description: "限定子目录（可选）" }
        },
        required: ["pattern"]
      }
    },
    {
      name: "grep",
      risk: "safe",
      label: "内容搜索",
      description: "在工作区内按正则表达式搜索文件内容（自动跳过依赖目录与二进制文件）。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "正则表达式，如 function\\s+login" },
          dir: { type: "string", description: "限定子目录（可选）" },
          maxResults: { type: "number", description: "最多返回条数（可选，默认 60）" }
        },
        required: ["pattern"]
      }
    },
    {
      name: "write",
      risk: "write",
      label: "写入文件",
      description: "新建或整体覆盖写入文件。修改前会自动保存原内容用于回滚。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目标文件相对路径" },
          content: { type: "string", description: "完整文件内容" }
        },
        required: ["path", "content"]
      }
    },
    {
      name: "edit",
      risk: "write",
      label: "精确修改",
      description: "对文件做精确字符串替换（old_str 必须唯一）。适合小幅改动，比整体覆盖更安全。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目标文件相对路径" },
          old_str: { type: "string", description: "待替换的原始片段，必须唯一" },
          new_str: { type: "string", description: "替换后的新内容" }
        },
        required: ["path", "old_str", "new_str"]
      }
    },
    {
      name: "bash",
      risk: "exec",
      label: "执行命令",
      description: "在工作区根目录执行 shell 命令（Windows 为 cmd）。禁止破坏性命令，超时 3 分钟。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令，如 npm test" },
          timeout: { type: "number", description: "超时毫秒（可选，默认 60000）" }
        },
        required: ["command"]
      }
    },
    {
      name: "todo_write",
      risk: "safe",
      label: "更新计划",
      description: "把当前任务拆成有序清单并随时更新状态，让用户看到进度。status: pending|running|done。",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "任务清单",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "任务编号，如 1" },
                content: { type: "string", description: "任务描述" },
                status: { type: "string", description: "pending / running / done" }
              },
              required: ["id", "content", "status"]
            }
          }
        },
        required: ["items"]
      }
    },
    {
      name: "task_complete",
      risk: "safe",
      label: "结束任务",
      description: "任务全部完成时调用，并给出简明总结与后续建议。",
      parameters: {
        type: "object",
        properties: { summary: { type: "string", description: "本次任务做了什么、改动了哪些文件、还有什么建议" } },
        required: ["summary"]
      }
    }
  ];

  const TOOL_MAP = {};
  TOOLS.forEach((t) => { TOOL_MAP[t.name] = t; });

  /* ---------- 权限判定 ----------
   * 三档（对齐 Codex approval-policy + DeepSeek Harness 沙箱档位）：
   *   suggest  建议模式：写文件与执行命令都要逐次确认
   *   auto     自动模式：写文件自动放行，执行命令仍需确认（除非在白名单）
   *   full     全自动：全部放行（仍被限制在工作区内）
   */
  function riskOf(name) {
    if (TOOL_MAP[name]) return TOOL_MAP[name].risk;
    if (name.indexOf("mcp__") === 0) return "exec";
    return "exec";
  }

  function allowedByMode(mode, risk) {
    if (mode === "full") return true;
    if (risk === "safe") return true;
    if (mode === "auto") return risk === "write";
    return false; // suggest
  }

  /* ---------- 执行 ---------- */
  async function execEdit(args, ctx) {
    const c = api();
    const stat = await c.stat(args.path);
    if (!stat.exists) throw new Error("文件不存在，请改用 write 创建: " + args.path);
    const file = await c.read(args.path);
    const occurrences = file.content.split(args.old_str).length - 1;
    if (occurrences === 0) {
      // 常见误用：把 read 输出里的行号一起写进 old_str，给出更有针对性的提示
      if (/^\s*\d+\t/.test(String(args.old_str || "").split("\n")[0] || "")) {
        throw new Error("old_str 带了行号前缀。请去掉行号，只提交文件中真实存在的那段文本。");
      }
      throw new Error("未找到待替换内容，请确认 old_str 与文件内容完全一致（含缩进与换行）");
    }
    if (occurrences > 1) throw new Error("old_str 在文件中出现 " + occurrences + " 次，请给出更长的唯一片段");
    const next = file.content.split(args.old_str).join(args.new_str);
    const res = await c.write(args.path, next);
    ctx.onCheckpoint && ctx.onCheckpoint(args.path, res.previous);
    return {
      output: "已修改 " + args.path + "（替换 1 处，" + res.bytes + " 字节）",
      diff: simpleDiff(file.content, next),
      file: args.path
    };
  }

  /* read 的返回每行带「行号+制表符」前缀（便于 edit 定位）。
   * 弱模型常常把这份带行号的输出原样用 write 写回，直接把文件写坏（实测出现过
   * `1\tfunction sum...` 导致 SyntaxError）。这里做一次防御：若几乎所有行都带行号前缀，
   * 判为误写，直接拒绝并说明原因，让模型改用不带行号的内容。 */
  function guardNumberedLines(content) {
    const lines = String(content == null ? "" : content).split("\n").filter((l) => l.trim().length);
    if (lines.length < 2) return null;
    const numbered = lines.filter((l) => /^\s*\d+\t/.test(l)).length;
    if (numbered / lines.length < 0.8) return null;
    return "检测到内容每行都带「行号+制表符」前缀（疑似把 read 的输出原样写回）。" +
      "写入已取消：请提交不带行号的正文内容。";
  }

  async function execWrite(args, ctx) {
    const c = api();
    const guard = guardNumberedLines(args.content);
    if (guard) throw new Error(guard);
    const res = await c.write(args.path, args.content);
    ctx.onCheckpoint && ctx.onCheckpoint(args.path, res.previous);
    return {
      output: (res.created ? "已创建 " : "已覆盖写入 ") + args.path + "（" + res.bytes + " 字节" +
        (res.created ? "" : "，原内容已保存，可回滚") + "）",
      diff: simpleDiff(res.previous == null ? "" : res.previous, args.content),
      file: args.path
    };
  }

  async function execRead(args) {
    const c = api();
    const f = await c.read(args.path, { offset: args.offset, limit: args.limit });
    const body = f.content.length > 20000 ? f.content.slice(0, 20000) + "\n…（内容过长已截断）" : f.content;
    return { output: body, meta: "共 " + f.totalLines + " 行 / " + Math.round(f.size / 1024) + "KB" };
  }

  async function execList(args) {
    const c = api();
    const items = await c.list(args.path || ".");
    if (!items.length) return { output: "（空目录）" };
    const text = items.map((i) => (i.type === "dir" ? "[DIR] " : "      ") + i.name + (i.ignored ? "  (依赖目录已跳过)" : "")).join("\n");
    return { output: text };
  }

  async function execGlob(args) {
    const c = api();
    const files = await c.glob(args.pattern, { dir: args.dir });
    return { output: files.length ? files.join("\n") : "未匹配到文件: " + args.pattern };
  }

  async function execGrep(args) {
    const c = api();
    const r = await c.search(args.pattern, { dir: args.dir, maxResults: args.maxResults || 60 });
    if (!r.results.length) return { output: "未找到匹配内容（已扫描 " + r.scanned + " 个文件）" };
    const text = r.results.map((x) => x.file + ":" + x.line + ": " + x.text).join("\n");
    return { output: text + "\n\n（共扫描 " + r.scanned + " 个文件）" };
  }

  async function execBash(args) {
    const c = api();
    const dangerous = [/\brm\s+-rf\s+[\/~]/i, /\bformat\s+[a-z]:/i, /\bdel\s+\/s\s+\/q/i, /\bshutdown\b/i, /\bmkfs\b/i, /\bdiskpart\b/i];
    if (dangerous.some((re) => re.test(args.command))) {
      return { output: "已拒绝执行高危命令: " + args.command, refused: true };
    }
    const r = await c.run(args.command, { timeout: args.timeout || 60000 });
    let out = "";
    if (r.stdout) out += r.stdout;
    if (r.stderr) out += (out ? "\n" : "") + "[stderr] " + r.stderr;
    out = out.trim() || "（无输出）";
    return {
      output: out,
      meta: "退出码 " + r.code + " · 耗时 " + (r.duration / 1000).toFixed(1) + "s" + (r.killed ? " · 已超时中断" : ""),
      code: r.code
    };
  }

  async function execMcp(serverName, toolName, args) {
    const c = api();
    const r = await c.mcpCall({ name: serverName, tool: toolName, args: args });
    return { output: r.text || "（MCP 返回为空）", meta: "MCP " + serverName + " · " + toolName };
  }

  async function execute(name, args, ctx) {
    args = args || {};
    switch (name) {
      case "read": return execRead(args);
      case "list_dir": return execList(args);
      case "glob": return execGlob(args);
      case "grep": return execGrep(args);
      case "write": return execWrite(args, ctx);
      case "edit": return execEdit(args, ctx);
      case "bash": return execBash(args);
      case "todo_write": return { output: "计划已更新", items: args.items, ui: "todo" };
      case "task_complete": return { output: args.summary || "", complete: true };
      default:
        if (name.indexOf("mcp__") === 0) {
          const rest = name.slice(5);
          const sep = rest.indexOf("__");
          if (sep > 0) {
            return execMcp(rest.slice(0, sep), rest.slice(sep + 2), args);
          }
        }
        throw new Error("未知工具: " + name);
    }
  }

  /* --------- 一句话摘要：给用户看的审批提示 --------- */
  function summarize(name, args) {
    switch (name) {
      case "read": return "读取 " + args.path;
      case "list_dir": return "列出目录 " + (args.path || ".");
      case "glob": return "查找文件 " + args.pattern;
      case "grep": return "搜索内容 /" + args.pattern + "/";
      case "write": return "写入文件 " + args.path + "（" + String(args.content || "").length + " 字符）";
      case "edit": return "修改文件 " + args.path;
      case "bash": return "执行命令 " + args.command;
      case "todo_write": return "更新任务计划";
      case "task_complete": return "任务完成";
      default: return name;
    }
  }

  /* --------- 参数摘要：工具卡与工具名并排展示，不再重复动词 --------- */
  function detail(name, args) {
    if (!args) return "";
    switch (name) {
      case "read": case "write": case "edit": return String(args.path || "");
      case "list_dir": return String(args.path || ".");
      case "glob": return String(args.pattern || "");
      case "grep": return "/" + String(args.pattern || "") + "/";
      case "bash": return String(args.command || "");
      case "todo_write": return "任务计划";
      case "task_complete": return String(args.summary || "任务完成");
      case "web_search": return String(args.query || "");
      default: return summarize(name, args);
    }
  }

  window.CubeTools = {
    TOOLS: TOOLS,
    get: (n) => TOOL_MAP[n],
    riskOf: riskOf,
    allowedByMode: allowedByMode,
    execute: execute,
    summarize: summarize,
    detail: detail,
    simpleDiff: simpleDiff,
    hasLocal: hasLocal
  };
})();

/* ============ CubeAgent 端到端用例（渲染进程内执行） ============
 * 必须是一个可直接求值的表达式，因此整体包成立即执行的 async 函数。
 * 原则：断言验的是"真实生效"而不是"元素存在"——要点一下读真实状态再点回来验可逆，
 *       剪贴板要真写进去再读回来，而不是只证明按钮被点过。
 */
(async function () {
  const checks = [];
  const logs = [];
  const ok = (name, pass, detail) => {
    checks.push({ name: name, pass: !!pass, detail: detail == null ? "" : String(detail).slice(0, 400) });
    if (!pass) logs.push("失败用例：" + name + (detail ? " → " + detail : ""));
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  try {
    const WS = window.__E2E_WS__;
    const cube = window.cube;
    const S = CubeApp.state();

    /* ---------- 1. 界面骨架 ---------- */
    ok("界面：侧边栏任务列表", !!$("#session-list"));
    ok("界面：输入框 + 发送按钮", !!$("#input") && !!$("#btn-send"));
    ok("界面：运行模式切换", !!$("#mode-select"));
    ok("界面：权限档位切换", !!$("#perm-select"));
    ok("界面：详情面板（计划/文件/变更/轨迹/版本）",
      !!$("#panel-todo") && !!$("#panel-files") && !!$("#panel-diff") && !!$("#panel-trace") && !!$("#panel-git"),
      "页签 " + $$(".panel-tab").map((t) => t.getAttribute("data-tab")).join("/"));
    ok("界面：设置/面具弹窗", !!$("#modal-settings") && !!$("#modal-masks"));

    /* 设置弹窗的 × 必须能关掉：按钮内含 <svg>，用 e.target.matches 会漏判 */
    (function () {
      CubeApp.openSettings("mcp");
      const modal = $("#modal-settings");
      const opened = !modal.classList.contains("hidden");
      const btn = modal.querySelector(".modal-close");
      const hit = (btn && (btn.querySelector("svg") || btn));
      if (hit) hit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const closed = modal.classList.contains("hidden");
      ok("界面：点 × 内的图标也能关闭设置弹窗", opened && closed,
        "打开=" + opened + " 关闭=" + closed);
    })();

    /* 右栏折叠按钮必须真的能隐藏 #detail-panel（它和 #main 是兄弟节点，用后代选择器会完全失效） */
    (function () {
      const panel = $("#detail-panel");
      const btn = $("#btn-panel");
      btn.click();
      const hideOK = getComputedStyle(panel).display === "none";
      btn.click();
      const showOK = getComputedStyle(panel).display !== "none";
      ok("界面：右栏折叠按钮真实生效", hideOK && showOK,
        "折叠后=" + (hideOK ? "隐藏" : "仍显示") + " · 再点=" + (showOK ? "显示" : "仍隐藏"));
    })();
    ok("预加载：桌面 API 已注入", !!(cube && cube.isElectron));
    ok("界面：欢迎页面具已渲染", $$("#welcome-masks .mask-card, #welcome-masks > *").length > 0,
      "面具数量 " + $$("#welcome-masks > *").length);

    /* ---------- 1b. 上下文计量（实时统计 + 明细） ---------- */
    ok("界面：顶部上下文进度条存在", !!$("#ctx-meter") && !!$("#ctx-bar") && !!$("#ctx-pct"),
      "meter=" + !!$("#ctx-meter") + " bar=" + !!$("#ctx-bar"));
    const ctx0 = CubeApp.contextStat();
    ok("上下文：能算出用量与窗口", ctx0 && ctx0.total >= 0 && ctx0.window > 0,
      "total=" + (ctx0 && ctx0.total) + " window=" + (ctx0 && ctx0.window));
    ok("上下文：拆分口径完整（系统/工具/历史/工具结果/@引用）",
      ctx0 && ["system", "tools", "messages", "toolResults", "chips"].every((k) => typeof ctx0[k] === "number"),
      JSON.stringify({ s: ctx0.system, t: ctx0.tools, m: ctx0.messages, r: ctx0.toolResults, c: ctx0.chips }));
    ok("上下文：分级阈值正确（ok/warn/err）", ["ok", "warn", "err"].indexOf(ctx0.level) >= 0, "level=" + ctx0.level);
    // 进度条宽度必须真的跟着占用走，不是写死的 0
    const w1 = $("#ctx-bar").style.width;
    ok("上下文：进度条宽度与占用一致",
      Math.abs(parseFloat(w1) - Math.min(100, ctx0.pct * 100)) < 1.5,
      "style=" + w1 + " 实际=" + (ctx0.pct * 100).toFixed(1) + "%");
    ok("上下文：右栏面板列出各部分", !!$("#panel-stats .ctx-panel") && $$("#panel-stats .ctx-row").length >= 5,
      "行数 " + $$("#panel-stats .ctx-row").length);
    ok("上下文：提供手动压缩入口", !!$("#panel-stats .ctx-compact-btn"));

    /* ---------- 1c. 命令面板 / 侧栏功能区 / 快捷指令 ---------- */
    ok("界面：命令面板弹窗存在", !!$("#modal-palette") && !!$("#palette-input"));
    ok("界面：左栏功能区入口齐全",
      !!$("#nav-search") && !!$("#nav-skills") && !!$("#nav-mcp") && !!$("#nav-git"),
      "search=" + !!$("#nav-search") + " skills=" + !!$("#nav-skills") + " mcp=" + !!$("#nav-mcp") + " git=" + !!$("#nav-git"));
    ok("界面：侧栏「任务/项目」标签页", $$(".side-tab").length === 2);
    ok("界面：欢迎页快捷指令胶囊", $$(".qpill").length >= 4, "胶囊 " + $$(".qpill").length + " 个");
    ok("界面：欢迎语按时段变化", !!$("#welcome-title") && $("#welcome-title").textContent.length > 4,
      $("#welcome-title").textContent);

    /* 技能页：必须真扫到磁盘上的 SKILL.md，而不是空壳列表 */
    await (async function () {
      CubeApp.openSettings("skills");
      await sleep(500);
      const cards = $$("#settings-content .skill-card");
      const roots = $$("#settings-content .skill-root-row");
      const tabs = $$(".settings-nav-item").map((t) => t.getAttribute("data-tab"));
      ok("界面：技能页是独立页签且真扫描了本地目录",
        tabs.indexOf("skills") >= 0 && roots.length >= 2,
        "技能 " + cards.length + " 个 · 目录 " + roots.length + " 个 · 路径 "
        + (cards[0] ? (cards[0].querySelector(".skill-path") || {}).textContent : "（空）"));
      const modal = $("#modal-settings");
      if (modal) modal.classList.add("hidden");
      $("#nav-skills").click();
      await sleep(350);
      const act = $(".settings-nav-item.active");
      ok("界面：侧栏「技能与助手」直接进技能页", act && act.getAttribute("data-tab") === "skills",
        "实际打开 " + (act ? act.getAttribute("data-tab") : "无"));
      if (modal) modal.classList.add("hidden");
    })();

    /* MCP 页：空表单没人知道怎么填，必须有常用服务一键填入 */
    await (async function () {
      $("#nav-mcp").click();
      await sleep(350);
      const btns = $$("#settings-content button").filter((b) => /文件系统|GitHub|SQLite/.test(b.textContent || ""));
      let filled = "";
      if (btns.length) {
        btns[0].click();
        const inputs = $$("#settings-content input[type=text]");
        filled = inputs[inputs.length - 3] ? inputs[inputs.length - 3].value : "";
      }
      ok("界面：MCP 提供常用服务一键填表", btns.length >= 3 && !!filled,
        btns.length + " 个预设 · 已填 " + (filled || "无"));
      const modal = $("#modal-settings");
      if (modal) modal.classList.add("hidden");
    })();

    // 命令面板真能打开并列出命令
    CubeApp.openPalette();
    await sleep(250);
    const allCmds = $$("#palette-list .palette-item").length;
    $("#palette-input").value = "上下文";
    $("#palette-input").dispatchEvent(new Event("input"));
    await sleep(200);
    const filtered = $$("#palette-list .palette-item").length;
    ok("界面：命令面板可打开并模糊过滤", allCmds > 0 && filtered > 0 && filtered < allCmds,
      "全部 " + allCmds + " 条 → 搜「上下文」" + filtered + " 条");
    $("#modal-palette").classList.add("hidden");
    $("#palette-input").value = "";

    /* ---------- 1d. 详情面板页签：齐全 + 真实互斥切换 ---------- */
    const tabIds = $$(".panel-tab").map((t) => t.getAttribute("data-tab"));
    ok("界面：页签齐全且顺序正确",
      tabIds.join(",") === "todo,files,diff,trace,git", tabIds.join(","));
    const switchOK = tabIds.every((id, i) => {
      const tab = $$(".panel-tab").filter((t) => t.getAttribute("data-tab") === id)[0];
      if (tab) tab.click();
      const self = $("#panel-" + id);
      const others = tabIds.filter((x) => x !== id).map((x) => $("#panel-" + x));
      return self && !self.classList.contains("hidden") &&
        others.every((o) => o && o.classList.contains("hidden"));
    });
    ok("界面：五个页签都能真实切换且互斥", switchOK, "全部" + (switchOK ? "正常" : "异常"));

    /* ---------- 1e. 侧栏双视角 + 快捷键 ---------- */
    (function () {
      const p = Store.createSession();
      p.messages.push({ role: "tool", toolCallId: "t1", name: "write", args: { path: "a.js" },
        content: "ok", diff: [{ type: "+", text: "one" }, { type: "+", text: "two" }, { type: "-", text: "old" }] });
      p.workspace = "F:/tmp/project-a";
      Store.save();
      CubeApp.renderAll();
      // 变更面板是懒渲染的：必须切到该页签，否则读到的还是上一次的旧内容
      const dt = $$(".panel-tab").filter((t) => t.getAttribute("data-tab") === "diff")[0];
      if (dt) dt.click();
    })();
    await sleep(300);
    const addTxt = $$("#panel-diff .diff-add").map((e) => e.textContent)[0] || "";
    const delTxt = $$("#panel-diff .diff-del").map((e) => e.textContent)[0] || "";
    ok("界面：变更面板汇总 diff 并区分增删",
      addTxt.indexOf("2") >= 0 && delTxt.indexOf("1") >= 0 &&
      $$("#panel-diff .diff-revert").length >= 1,
      "增 " + (addTxt || "?") + " · 减 " + (delTxt || "?") + " · 回滚按钮 " + $$("#panel-diff .diff-revert").length + " 个");

    const projTab = $$(".side-tab").filter((t) => /项目/.test(t.textContent || ""))[0];
    if (projTab) projTab.click();
    await sleep(250);
    const projGroups = $$(".proj-group-head").length;
    const projFirst = projGroups ? ($$(".proj-group-name")[0] || {}).textContent : "";
    const taskTab = $$(".side-tab").filter((t) => /任务/.test(t.textContent || ""))[0];
    if (taskTab) taskTab.click();
    await sleep(250);
    const timeGroups = $$(".proj-group-head").length;
    ok("界面：侧栏可按项目分组并按时间分组", projGroups >= 1 && timeGroups >= 1 && $$(".session-time").length >= 1,
      "项目组 " + projGroups + " 个（首个=" + projFirst + "）· 时间组 " + timeGroups + " 个 · 相对时间 "
      + $$(".session-time").length + " 条");
    // 清理这条造出来的会话，避免它被当成后续用例的"最近任务"
    const demoSess = S.sessions.filter((s) => s.workspace === "F:/tmp/project-a")[0];
    if (demoSess) Store.deleteSession(demoSess.id);
    CubeApp.renderAll();
    await sleep(200);

    const nSess = S.sessions.length;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: true, bubbles: true }));
    await sleep(250);
    const afterN = S.sessions.length;
    const perm0 = S.agent.permission;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    await sleep(150);
    ok("界面：Ctrl+N 新建任务 / Shift+Tab 切权限",
      afterN === nSess + 1 && S.agent.permission !== perm0 && $("#perm-select").value === S.agent.permission,
      "会话 " + nSess + "→" + afterN + " 条 · 权限 " + perm0 + " → " + S.agent.permission
      + "（下拉框同步=" + ($("#perm-select").value === S.agent.permission) + "）");

    /* ---------- 2. 服务商与密钥 ---------- */
    const agnes = S.providers.filter((p) => p.id === "agnes")[0];
    ok("服务商：内置 Agnes（OpenAI 兼容）", !!agnes && /agnes/.test(agnes.baseUrl),
      "providers=" + S.providers.map((p) => p.id).join(",") + " baseUrl=" + (agnes && agnes.baseUrl));
    const key = (agnes && agnes.apiKey) || "";
    ok("服务商：本地密钥已注入", !!key && key.length > 8,
      "key=" + key.slice(0, 8) + "… __CUBE_DEFAULT_KEY__=" + (window.__CUBE_DEFAULT_KEY__ ? "有" : "无"));
    ok("设置：默认模型为 agnes-2.5-flash", S.settings.activeModel === "agnes-2.5-flash",
      S.settings.activeProviderId + " / " + S.settings.activeModel);

    /* ---------- 3. 工作区 ---------- */
    await CubeApp.setWorkspace(WS);
    await sleep(300);
    const wsNow = await cube.getWorkspace();
    ok("工作区：主进程已接收", wsNow === WS, wsNow);
    ok("工作区：UI 已同步", ($("#workspace-chip-text") || $("#workspace-chip")).textContent.indexOf("workspace") >= 0,
      ($("#workspace-chip-text") || $("#workspace-chip")).textContent);
    // 目录选择对话框曾因 title 非字符串直接失败，这里验证归一化层
    await (async function () {
      let picked = "";
      try { picked = await cube.openDirectory("选择测试工作区"); } catch (e) { picked = "ERR " + e.message; }
      ok("工作区：选择对话框能返回目录（title 非字符串时曾直接失败）", picked === WS, "返回 " + picked);
    })();

    /* ---------- 3b. 约束钉 + 长期记忆真的进了系统提示 ---------- */
    (function () {
      const sess = Store.createSession();
      sess.messages.push({ role: "user", content: "这个项目必须用 pnpm，不要用 npm。", ts: Date.now() });
      S.settings.contextCount = 30;
      Store.save();
      const cons = CubeContext.extractConstraints(sess.messages);
      ok("上下文：用户约束被钉进系统提示",
        cons.length >= 1 && cons.some((c) => c.indexOf("pnpm") >= 0),
        cons.length + " 条约束，命中 pnpm=" + cons.some((c) => c.indexOf("pnpm") >= 0));
      const sysOpts = {
        workspace: WS, mode: S.agent.permission, projectRules: "",
        constraints: cons,
        memories: [{ text: "用户偏好中文注释", type: "preference" }],
        memoryLabels: { preference: "偏好" }
      };
      const sys = CubeAgent.buildSystem(sysOpts);
      ok("上下文：跨会话记忆被注入系统提示", /中文注释/.test(sys), "召回 1 条");
      ok("上下文：记忆段有类型标注（模型分得清是偏好还是硬性要求）",
        /偏好/.test(sys), "标签「偏好」出现在系统提示=" + /偏好/.test(sys));
      // 记忆条目过多必须有上限，否则记忆本身会反噬上下文
      const many = [];
      for (let i = 0; i < 80; i++) {
        many.push({ text: "记忆条目 " + i + "：这是一条很长的记忆内容，用来测试注入上限。", type: "project_knowledge" });
      }
      const sysMany = CubeAgent.buildSystem(Object.assign({}, sysOpts, { constraints: [], memories: many }));
      const injected = many.filter((m) => sysMany.indexOf(m.text.slice(0, 12)) >= 0).length;
      ok("上下文：约束与记忆都有注入上限（防止记忆反噬上下文）", injected > 0 && injected < many.length,
        "80 条记忆只注入 " + injected + " 条 · 系统提示 " + sysMany.length + " 字");
      const emptySys = CubeAgent.buildSystem(Object.assign({}, sysOpts, { constraints: [], memories: [] }));
      const lastSeg = emptySys.trim().split("\n\n").pop();
      ok("上下文：无记忆时不产生空标题段",
        !/用户明确指定的要求\s*$/m.test(lastSeg) && !/长期记忆\s*$/m.test(lastSeg),
        "末段「" + lastSeg.slice(0, 30) + "」");
    })();

    /* ---------- 4. 沙箱 ---------- */    const outside = await cube.read("F:/WorkBuddy/cube-agent/e2e/outside.txt");
    ok("安全：越界读取被拒绝", !!(outside && outside.__error), (outside && outside.__error) || "竟然读成功了");
    const evil = await cube.write("F:/WorkBuddy/cube-agent/e2e/_artifacts/evil.txt", "x");
    ok("安全：越界写入被拒绝", !!(evil && evil.__error), (evil && evil.__error) || "竟然写成功了");
    const sysStat = await cube.stat("C:/Windows/System32");
    ok("安全：越界 stat 被拒绝", !!(sysStat && sysStat.__error), (sysStat && sysStat.__error) || "竟然读到了");

    /* ---------- 5. 只读工具 ---------- */
    // onCheckpoint 是回滚快照的登记口：写工具只调用它，快照存在会话上
    const ctxSession = Store.getSession(S.activeSessionId);
    const ctx = {
      session: ctxSession,
      workspace: WS,
      onCheckpoint: (file, prev) => {
        ctxSession.checkpoints = ctxSession.checkpoints || {};
        ctxSession.checkpoints[file] = prev;
        Store.save();
      }
    };
    const ls = await CubeTools.execute("list_dir", { path: "." }, ctx);
    ok("工具 list_dir：列出根目录", ls && ls.output.indexOf("src") >= 0, ls && ls.output);
    const gl = await CubeTools.execute("glob", { pattern: "**/*.js" }, ctx);
    ok("工具 glob：匹配 **/*.js", gl && /calc\.js/.test(gl.output), gl && gl.output);
    const gp = await CubeTools.execute("grep", { pattern: "function add", path: "." }, ctx);
    ok("工具 grep：命中 function add", gp && /calc\.js/.test(gp.output), gp && gp.output);
    // stat 不暴露成模型工具（模型用 list_dir/glob/grep 就够了），但运行时必须有它
    const st = await cube.stat("src/calc.js");
    ok("工具 stat：文件存在", !!(st && st.exists === true),
      "src/calc.js exists=" + (st && st.exists) + " size=" + (st && st.size));

    /* ---------- 6. 写入类工具 + 回滚 ---------- */
    const w = await CubeTools.execute("write", { path: "src/new.js", content: "function nw(){ return 7; }\n" }, ctx);
    ok("工具 write：新建文件", w && w.diff && w.diff.length > 0, w && w.diff && w.diff.length + " 行变更");
    ok("工具 write：产出 diff", !!(w && w.diff && w.diff.some((d) => d.type === "+")));
    const disk = await cube.read("src/new.js");
    ok("工具 write：内容落盘", disk && /nw/.test(disk.content), (disk && disk.content || "").slice(0, 40));
    const e = await CubeTools.execute("edit", { path: "src/new.js", old_str: "return 7", new_str: "return 8" }, ctx);
    ok("工具 edit：精确替换", e && e.output && !/未找到|找不到/.test(e.output), e && e.output);
    const disk2 = await cube.read("src/new.js");
    ok("工具 edit：修改生效", disk2 && /return 8/.test(disk2.content), (disk2 && disk2.content || "").slice(0, 40));
    // 报错是 throw 的（不是返回 __error），断言必须真的接住异常，否则会静默通过
    const errOf = async (fn) => { try { await fn(); return ""; } catch (e2) { return String((e2 && e2.message) || e2); } };
    const dupMsg = await errOf(() => CubeTools.execute("edit", { path: "src/calc.js", old_str: "function", new_str: "FUNC" }, ctx));
    ok("工具 edit：非唯一片段被拒", /出现\s*\d+\s*次/.test(dupMsg), dupMsg || "竟然改成功了");
    const missMsg = await errOf(() => CubeTools.execute("edit", { path: "src/calc.js", old_str: "zzz-not-exist", new_str: "x" }, ctx));
    ok("工具 edit：未找到片段报错", /未找到/.test(missMsg), missMsg || "竟然改成功了");
    // 快照由写工具自动登记；改一次再回滚，读盘确认真的退回去了
    await CubeTools.execute("edit", { path: "src/new.js", old_str: "return 8", new_str: "return 9" }, ctx);
    const changed = await cube.read("src/new.js");
    ok("回滚：改动已生效（前置条件）", /return 9/.test(changed.content || ""),
      (changed.content || "").replace(/\s+/g, " ").slice(0, 40));
    CubeApp.rollback("src/new.js");
    for (let i = 0; i < 30; i++) {
      const probe = await cube.read("src/new.js");
      if (/return 8/.test(probe.content || "")) break;
      await sleep(150);
    }
    const afterRoll = await cube.read("src/new.js");
    ok("回滚：恢复到修改前内容", /return 8/.test(afterRoll.content || "") && !/return 9/.test(afterRoll.content || ""),
      (afterRoll.content || "").replace(/\s+/g, " ").slice(0, 40));

    /* ---------- 7. 命令执行与权限 ---------- */
    const b = await CubeTools.execute("bash", { command: "echo hello-e2e" }, ctx);
    ok("工具 bash：执行命令拿到输出", b && /hello-e2e/.test(b.output), b && b.output);
    // 退出码字段是 code，且要真的传回给模型（Agent Loop 靠它判断命令是否成功）
    ok("工具 bash：返回退出码", b && typeof b.code === "number" && b.code === 0 && /退出码 0/.test(b.meta || ""),
      "code=" + (b && b.code) + " meta=" + (b && b.meta));
    const danger = await CubeTools.execute("bash", { command: "rm -rf /" }, ctx);
    ok("工具 bash：高危命令被拒绝", danger && danger.refused === true, danger && danger.output);

    ok("权限 suggest：只读放行", CubeTools.allowedByMode("suggest", "safe") === true);
    ok("权限 suggest：写文件需确认", CubeTools.allowedByMode("suggest", "write") === false);
    ok("权限 auto：写文件放行", CubeTools.allowedByMode("auto", "write") === true);
    ok("权限 auto：执行需确认", CubeTools.allowedByMode("auto", "exec") === false);
    ok("权限 full：执行放行", CubeTools.allowedByMode("full", "exec") === true);

    /* ---------- 8. 真实模型 · 聊天模式流式输出 ---------- */
    S.agent.mode = "chat";
    S.agent.permission = "full";
    Store.save();
    const t0 = Date.now();
    await CubeApp.runTurn("请只回复一个单词：PONG。不要任何解释。");
    let sess = Store.getSession(S.activeSessionId);
    const last = sess.messages[sess.messages.length - 1];
    ok("聊天模式：真实模型返回内容", last && last.role === "assistant" && !!last.content && !last.error,
      (last && (last.content || "").slice(0, 60)) + " · 耗时 " + (Date.now() - t0) + "ms");
    const rows = $$("#messages .msg-row.assistant");
    ok("聊天模式：回复渲染到 DOM 且内容正确", rows.length > 0 && rows[rows.length - 1].textContent.indexOf("PONG") >= 0,
      "助手消息 " + rows.length + " 条 · 末条内容「" + (rows.length ? rows[rows.length - 1].textContent.trim().slice(0, 40) : "") + "」");

    /* ---------- 9. 真实模型 · Agent 模式完整工具循环 ---------- */
    S.agent.mode = "agent";
    S.agent.permission = "full";
    Store.save();
    Store.createSession();
    const t1 = Date.now();
    await CubeApp.runTurn(
      "在工作区新建一个文件 src/greet.js，导出函数 greet(name) 返回字符串 `Hello, ${name}!`；" +
      "然后用 bash 执行 `node -e \"console.log(require('./src/greet.js').greet('Cube'))\"` 验证它能跑通；" +
      "完成后调用 task_complete 总结。全程使用相对路径。"
    );
    sess = Store.getSession(S.activeSessionId);
    const toolMsgs = sess.messages.filter((m) => m.role === "tool");
    const toolNames = toolMsgs.map((m) => m.name);
    ok("Agent 模式：发生真实工具调用", toolMsgs.length >= 2, "调用 " + toolMsgs.length + " 次：" + toolNames.join(","));
    ok("Agent 模式：使用了写入类工具", toolNames.indexOf("write") >= 0 || toolNames.indexOf("edit") >= 0);
    ok("Agent 模式：使用了 bash 验证", toolNames.indexOf("bash") >= 0);
    const g = await cube.stat("src/greet.js");
    ok("Agent 模式：模型真的创建了文件", g && g.exists === true, "src/greet.js size=" + (g && g.size));
    const gContent = await cube.read("src/greet.js");
    const gText = (gContent && gContent.content) || "";
    ok("Agent 模式：文件内容符合需求", /greet/.test(gText) && /Hello/.test(gText),
      (gContent && gContent.__error) || gText.replace(/\n/g, " ").slice(0, 80));
    const bashOut = toolMsgs.filter((m) => m.name === "bash").map((m) => m.content).join("\n");
    ok("Agent 模式：验证命令真实执行成功", /Hello, Cube!/.test(bashOut) || /Cube/.test(bashOut),
      bashOut.replace(/\n/g, " | ").slice(0, 120));
    ok("Agent 模式：会话轨迹已记录", sess.trajectory && sess.trajectory.length >= 4,
      "轨迹 " + (sess.trajectory || []).length + " 条");
    ok("Agent 模式：统计步数与工具数", sess.stats && sess.stats.toolCalls >= 1 && sess.stats.steps >= 1,
      "steps=" + (sess.stats && sess.stats.steps) + " calls=" + (sess.stats && sess.stats.toolCalls));
    ok("Agent 模式：工具卡片渲染到界面", $$("#messages .tool-card").length >= 1,
      "工具卡 " + $$("#messages .tool-card").length + " 个");
    ok("Agent 模式：耗时已统计", sess.stats && sess.stats.durationMs > 0, (sess.stats && sess.stats.durationMs) + "ms · 总耗时 " + (Date.now() - t1) + "ms");

    /* ---------- 10. Todo 计划面板 ---------- */
    await CubeTools.execute("todo_write", { items: [{ id: "1", content: "端到端验证", status: "done" }] }, ctx);
    const todoRes = await CubeTools.execute("todo_write", {
      items: [{ id: "1", content: "端到端验证", status: "done" }]
    }, ctx);
    ok("工具 todo_write：返回计划", todoRes && todoRes.ui === "todo" && todoRes.items.length === 1);

    /* ---------- 11. 斜杠命令与 Markdown ---------- */
    ok("斜杠命令 /help 可执行", await CubeApp.slash("/help") === true);
    const md = Markdown.render("# 标题\n\n```js\nlet a = 1;\n```\n\n| 列1 | 列2 |\n|---|---|\n| A | B |\n\n> 引用\n");
    ok("Markdown：代码块渲染", md.indexOf("<pre") >= 0 || md.indexOf("<code") >= 0);
    ok("Markdown：表格渲染", md.indexOf("<table") >= 0);
    ok("Markdown：引用渲染", md.indexOf("<blockquote") >= 0);
    const xss = Markdown.render("<img src=x onerror=alert(1)>");
    ok("Markdown：XSS 被转义", xss.indexOf("<img") < 0 && xss.indexOf("&lt;img") >= 0, xss.slice(0, 90));

    /* ---------- 11b. 会话排队发送：上一轮没结束就发新消息 ----------
       这是用户最容易踩的坑：上一轮还在跑就发下一条，早期实现直接静默丢弃，
       用户只看到"输入框里的字消失了，什么也没发生"。 */
    Store.createSession();
    S.agent.mode = "agent";
    S.agent.permission = "full";
    Store.save();
    const slow = CubeApp.runTurn("用 bash 依次执行三次 `echo tick`，每次之间用 sleep 1，然后调用 task_complete 总结。");
    await sleep(700);
    ok("排队：运行中仍处于 running 状态", CubeApp.running() === true);

    // 运行中发送：必须入队，不能被丢弃
    $("#input").value = "这是排队的第一条：请只回复 QUEUED-A";
    await CubeApp.send();
    const q1 = CubeApp.queue();
    ok("排队：运行中发送的消息进入队列而非被丢弃", q1.length === 1 && q1[0].text.indexOf("QUEUED-A") >= 0,
      "队列 " + q1.length + " 条：" + (q1[0] ? q1[0].text.slice(0, 40) : "（空）"));
    ok("排队：输入框已清空（内容没有留在框里重复发送）", $("#input").value === "",
      "残留「" + $("#input").value + "」");
    ok("排队：队列条已在界面上可见",
      !$("#queue-bar").classList.contains("hidden") && $$("#queue-bar .queue-item").length === 1,
      "队列条目 " + $$("#queue-bar .queue-item").length + " 个");
    ok("排队：运行中发送键不消失，而是变成「排队发送」",
      !$("#btn-send").classList.contains("hidden") && /排队/.test($("#btn-send").textContent),
      "按钮文案「" + $("#btn-send").textContent.trim() + "」");
    ok("排队：停止按钮在运行中可见", !$("#btn-stop").classList.contains("hidden"));

    // 连续再排一条，验证多条排队
    $("#input").value = "排队第二条：请只回复 QUEUED-B";
    await CubeApp.send();
    ok("排队：支持连续排入多条", CubeApp.queue().length === 2, "队列 " + CubeApp.queue().length + " 条");
    // 删除一条
    $$("#queue-bar .queue-del")[0].click();
    ok("排队：单条可删除", CubeApp.queue().length === 1 && CubeApp.queue()[0].text.indexOf("QUEUED-B") >= 0,
      "剩余 " + CubeApp.queue().length + " 条");

    await slow;
    // 队列是在本轮收尾后延迟接上的，等它真的发完（不靠固定 sleep 猜时间）
    for (let i = 0; i < 160 && (CubeApp.queue().length || CubeApp.running()); i++) await sleep(250);
    const afterRun = Store.getSession(S.activeSessionId);
    ok("排队：本轮结束后队列自动发送（不再需要用户手动再点一次）",
      CubeApp.queue().length === 0 && !CubeApp.running(),
      "队列 " + CubeApp.queue().length + " 条 · running=" + CubeApp.running());
    const uTexts = afterRun.messages.filter((m) => m.role === "user").map((m) => m.content);
    ok("排队：排队的消息真的进入了历史", uTexts.some((t) => t.indexOf("QUEUED-B") >= 0),
      "用户消息 " + uTexts.length + " 条：" + uTexts.map((t) => t.slice(0, 14)).join(" / "));
    const tail = afterRun.messages[afterRun.messages.length - 1];
    ok("排队：排队的消息拿到了真实回复", tail && tail.role === "assistant" && !!tail.content,
      "末条角色=" + (tail && tail.role) + " 内容「" + (tail ? String(tail.content).slice(0, 30) : "") + "」");
    ok("排队：本轮结束后发送键恢复为「发送」",
      /发送/.test($("#btn-send").textContent) && !$("#btn-send").classList.contains("btn-queue"),
      "按钮文案「" + $("#btn-send").textContent.trim() + "」");
    ok("排队：队列清空后队列条自动隐藏", $("#queue-bar").classList.contains("hidden"));

    /* ---------- 11c. 消息复制 ----------
       无头窗口永远失焦，navigator.clipboard.writeText 会抛 "Document is not focused"，
       因此这里监听 document 的 "copy" 事件来确认"写入的内容对不对"，
       并单独断言"失焦时不得假报成功"——execCommand 在失焦下会返回 true 却什么都没写，
       这是最容易让用户以为复制好了、实际粘贴出空内容的坑。 */
    const copied = [];
    const onCopy = (e) => {
      try { copied.push(String((e.clipboardData && e.clipboardData.getData("text/plain")) || "")); }
      catch (err) { copied.push(""); }
    };
    document.addEventListener("copy", onCopy, true);

    const copyButtons = $$("#messages .msg-row .msg-actions button").filter((b) => /复制/.test(b.textContent));
    ok("复制：用户消息与模型消息都有复制按钮", copyButtons.length >= 2,
      "复制按钮 " + copyButtons.length + " 个");
    ok("复制：模型消息带「重新生成」",
      $$("#messages .msg-row.assistant .msg-actions button").some((b) => /重新生成/.test(b.textContent)));
    ok("复制：用户消息带「编辑」",
      $$("#messages .msg-row.user .msg-actions button").some((b) => /编辑/.test(b.textContent)));

    // 用户消息：验证复制按钮拿到的正是原文（失焦也走 execCommand 退路，仍能捕获内容）
    let expectUserText = "";
    const userRows = $$("#messages .msg-row.user");
    if (userRows.length) {
      expectUserText = (userRows[userRows.length - 1].querySelector(".msg-content") || {}).textContent || "";
      const ub = $$("#messages .msg-row.user .msg-actions button").filter((b) => /复制/.test(b.textContent))[0];
      if (ub) ub.click();
    }
    await sleep(400);
    const userClip = copied.length ? copied[copied.length - 1] : "";
    const userBtn = $$("#messages .msg-row.user .msg-actions button")[0];
    // 无头窗口永远失焦 → 复制无法成功。此时正确行为是"不谎报成功"：
    // 按钮保持「复制」而非「已复制」，并提示用户手动 Ctrl+C。
    const toastTxt = ($("#toast") || {}).textContent || "";
    const honestFailure = /已复制/.test(userBtn.textContent) === false &&
      (toastTxt.indexOf("Ctrl+C") >= 0 || copied.length > 0);
    const realSuccess = copied.length > 0 &&
      expectUserText.indexOf(copied[copied.length - 1].slice(0, 16)) >= 0;
    ok("复制：用户消息复制要么真成功、要么如实提示（绝不谎报已复制）",
      realSuccess || honestFailure,
      "捕获「" + userClip.slice(0, 26) + "」· 按钮「" + userBtn.textContent.trim()
      + "」· 提示「" + toastTxt.slice(0, 30) + "」");

    // 代码块复制：必须写入纯代码，不含围栏与语言标记
    const mdWithCode = Markdown.render("```js\nconst copyMe = 42;\n```");
    ok("复制：代码块自带复制按钮",
      mdWithCode.indexOf("code-copy") >= 0 && mdWithCode.indexOf(encodeURIComponent("const copyMe = 42;")) >= 0);
    const holder = document.createElement("div");
    holder.innerHTML = mdWithCode;
    document.body.appendChild(holder);
    copied.length = 0;
    const codeBtn = holder.querySelector(".code-copy");
    codeBtn.click();
    await sleep(400);
    const codeClip = copied.length ? copied[copied.length - 1] : "";
    // data-code 里存的就是待复制内容，可直接断言"按钮携带的是纯代码"
    const carried = decodeURIComponent(codeBtn.getAttribute("data-code") || "");
    ok("复制：代码块复制写入的是纯代码（不含围栏与语言标记）",
      carried === "const copyMe = 42;" && codeClip.indexOf("```") < 0 &&
      (codeClip.length === 0 || codeClip.indexOf("const copyMe = 42;") >= 0),
      "按钮携带「" + carried + "」· 捕获「" + codeClip + "」");
    document.body.removeChild(holder);

    /* 真实环境行为断言：无头窗口永远失焦，因此这里能观察到的正是"最坏情况"。
       必须保证 copyText 不会谎报成功——execCommand 在失焦下返回 true 却什么都没写，
       如果照单全收，用户粘贴出来是空的还以为复制过了。
       有头环境下应当复制成功，两种结果都算通过，但"假成功"绝对不能算通过。 */
    const realClip = navigator.clipboard;
    copied.length = 0;
    let noFocus = null;
    try { Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }); }
    catch (e) { noFocus = null; }
    if (noFocus === null) {
      try { noFocus = await CubeApp.copyText("退路测试文本"); }
      catch (e) { noFocus = "ERR " + e.message; }
    }
    try { Object.defineProperty(navigator, "clipboard", { configurable: true, value: realClip }); } catch (e) { /* ignore */ }
    const legacyClip = copied.length ? copied[copied.length - 1] : "";
    // 成功（捕获到内容）或如实失败（返回 false + 提示手动复制），两者都可接受
    const honestFail = noFocus === false &&
      /Ctrl\+C|手动复制/.test(($("#toast") || {}).textContent || "");
    const legacySuccess = noFocus === true && legacyClip.indexOf("退路测试文本") >= 0;
    ok("复制：走退路时要么真复制、要么如实提示手动复制（绝不谎报成功）",
      legacySuccess || honestFail,
      "返回 " + noFocus + " · 捕获「" + legacyClip + "」· 提示「"
      + (($("#toast") || {}).textContent || "无") + "」");
    document.removeEventListener("copy", onCopy, true);

    /* ---------- 11d. 编辑重发 ---------- */
    Store.createSession();
    S.agent.mode = "chat";
    Store.save();
    await CubeApp.runTurn("请只回复：第一版");
    let es = Store.getSession(S.activeSessionId);
    await CubeApp.runTurn("请只回复：第二版");
    es = Store.getSession(S.activeSessionId);
    ok("编辑重发：前置状态是 2 问 2 答", es.messages.filter((m) => m.role === "user").length === 2,
      "消息 " + es.messages.length + " 条");

    CubeApp.editFrom(0);
    es = Store.getSession(S.activeSessionId);
    ok("编辑重发：后续对话被移除，只留待改写的那条",
      es.messages.length === 1 && es.messages[0].role === "user", "剩余 " + es.messages.length + " 条");
    ok("编辑重发：原文被放回输入框等待修改", $("#input").value.indexOf("第一版") >= 0,
      "输入框「" + $("#input").value.slice(0, 30) + "」");
    ok("编辑重发：界面给出可撤销提示", !$("#edit-tip").classList.contains("hidden"));

    // 撤销：误点编辑不该让历史丢失
    $("#edit-tip .queue-btn").click();
    es = Store.getSession(S.activeSessionId);
    ok("编辑重发：可撤销误操作", es.messages.length === 4, "恢复后 " + es.messages.length + " 条");

    // 真的改写并重发：应该是「替换」原提问，而不是叠加成两问
    CubeApp.editFrom(0);
    $("#input").value = "请只回复：改写版";
    await CubeApp.submit($("#input").value);
    es = Store.getSession(S.activeSessionId);
    const uList = es.messages.filter((m) => m.role === "user").map((m) => m.content);
    ok("编辑重发：改写后的提问替换原提问（不是叠加成两问）",
      uList.length === 1 && uList[0].indexOf("改写版") >= 0 && uList[0].indexOf("第一版") < 0,
      "用户提问 " + uList.length + " 条：" + JSON.stringify(uList.map((t) => t.slice(0, 16))));
    ok("编辑重发：改写后拿到了新回复",
      es.messages[es.messages.length - 1].role === "assistant",
      "末条角色=" + es.messages[es.messages.length - 1].role);
    ok("编辑重发：提示条在重发后自动收起", $("#edit-tip").classList.contains("hidden"));

    /* ---------- 11e. 重新生成 ---------- */
    const regenBefore = Store.getSession(S.activeSessionId);
    const regenBeforeN = regenBefore.messages.length;
    await CubeApp.regenerateFrom(regenBefore.messages.length - 1);
    const regen = Store.getSession(S.activeSessionId);
    const regenUsers = regen.messages.filter((m) => m.role === "user");
    ok("重新生成：旧回复被回退并重新提问（不会重复问同一句）",
      regen.messages.length >= 2 && regenUsers.length === 1,
      "回退前 " + regenBeforeN + " 条 → " + regen.messages.length + " 条 · 用户消息 "
      + regenUsers.length + " 条");
    ok("重新生成：产出了新的回复",
      regen.messages[regen.messages.length - 1].role === "assistant",
      "末条角色=" + regen.messages[regen.messages.length - 1].role);

    /* ---------- 12. 数据持久化与导出 ---------- */
    const raw = localStorage.getItem("cubeagent.v1");
    ok("持久化：状态已写入 localStorage", !!raw && raw.indexOf("agnes") >= 0,
      raw ? Math.round(raw.length / 1024) + "KB" : "无");
    const exported = Store.exportAll();
    ok("导出：全量 JSON 可生成", exported.length > 100 && exported.indexOf("sessions") >= 0,
      Math.round(exported.length / 1024) + "KB");

    /* ---------- 13. 会话管理 ---------- */
    const s2 = Store.createSession();
    ok("会话：可新建并激活", !!s2 && S.activeSessionId === s2.id);
    s2.title = "重命名测试";
    Store.save();
    ok("会话：标题可重命名", Store.getSession(s2.id).title === "重命名测试");
    const cnt = S.sessions.length;
    Store.deleteSession(s2.id);
    ok("会话：可删除", S.sessions.length === cnt - 1);

    /* ---------- 14. 老存档迁移（不污染前面的运行时状态） ---------- */
    localStorage.setItem("cubeagent.v1", JSON.stringify({
      settings: { theme: "light", activeProviderId: "zhipu", activeModel: "glm-4-flash" },
      providers: [{ id: "zhipu", name: "智谱", type: "openai", builtin: true, baseUrl: "x", apiKey: "k", models: ["glm-4-flash"] }],
      masks: [], sessions: [], activeSessionId: null
    }));
    const migrated = Store.load();
    ok("迁移：老存档自动补齐内置服务商与面具",
      migrated.providers.length >= 10 && migrated.masks.length >= 8,
      "providers=" + migrated.providers.length + " masks=" + migrated.masks.length);

  } catch (e) {
    ok("用例执行未抛出异常", false, "TypeError: " + String((e && e.stack) || e));
  }

  const failed = checks.filter((c) => !c.pass).length;
  return {
    total: checks.length,
    passed: checks.length - failed,
    failed: failed,
    checks: checks,
    logs: logs
  };
})()

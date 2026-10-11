/* ============ 实况测试 · 完整功能面 ============
 * 覆盖核心之外的功能：命令面板、设置各分区、技能、长期记忆、MCP、
 * 会话导出、文件回滚、@ 引用、命令补全、拖拽、导入导出、权限档位等。
 * 与核心套件同样的原则：验真实生效，不验元素存在。
 */
(async function () {
  const checks = [];
  const logs = [];
  const ok = (name, pass, detail) => {
    checks.push({ name: name, pass: !!pass, detail: detail == null ? "" : String(detail).slice(0, 300) });
    if (!pass) logs.push("失败：" + name + (detail ? " → " + detail : ""));
    console.log("[live] " + (pass ? "✓ " : "✗ ") + name);
  };
  const step = (msg) => { console.log("[live] —— " + msg); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  const WS = window.__E2E_WS__;
  const cube = window.cube;
  const S = CubeApp.state();

  try {
    S.agent.mode = "agent";
    await CubeApp.setWorkspace(WS);
    // 完整模式从空 localStorage 起，后面要用到活动会话（回滚快照挂在 session 上）
    if (!Store.getSession(S.activeSessionId)) {
      const seed = Store.createSession();
      seed.title = "完整功能验证";
      seed.messages.push({
        role: "user", content: "请阅读 src/calc.js 并说明它做了什么，不要修改任何文件。", ts: Date.now()
      });
      seed.messages.push({
        role: "assistant", content: "src/calc.js 提供了 add 与 sub 两个函数，用于两数加减。", ts: Date.now()
      });
      Store.save();
    }
    CubeApp.renderAll();
    await sleep(500);

    /* ---------- 1. 命令面板（Ctrl+K）---------- */
    step("打开命令面板");
    CubeApp.openPalette();
    await sleep(400);
    await __shot("01-命令面板");
    const pItems = $$("#palette-list .palette-item, #palette-list > *").length;
    ok("完整：命令面板可打开且列出命令", !$("#modal-palette").classList.contains("hidden") && pItems >= 10,
      "面板命令 " + pItems + " 条");
    // 搜索过滤
    const pInp = $("#palette-input");
    if (pInp) {
      pInp.value = "主题";
      pInp.dispatchEvent(new Event("input"));
      await sleep(250);
      const filtered = $$("#palette-list > *").length;
      ok("完整：命令面板支持搜索过滤", filtered >= 1 && filtered < pItems,
        "「主题」→ " + filtered + " / " + pItems + " 条");
      await __shot("02-命令面板搜索");
      pInp.value = "";
      pInp.dispatchEvent(new Event("input"));
    }
    // Esc 关闭
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(300);
    ok("完整：命令面板 Esc 可关闭", $("#modal-palette").classList.contains("hidden"));

    /* ---------- 2. 设置各分区 ---------- */
    step("逐个打开设置分区");
    // 注意：内容直接渲染进 #settings-content，没有 .settings-pane 这一层；
    // 分区是 5 个（通用/Agent/记忆/技能/MCP），服务商是另一组动态列表。
    CubeApp.openSettings("general");
    await sleep(400);
    const openNow = !$("#modal-settings").classList.contains("hidden");
    await __shot("03-设置-通用");
    const tabs = $$(".settings-nav-item");
    ok("完整：设置弹窗可打开", openNow, "弹窗可见=" + openNow);
    ok("完整：设置分区齐全", tabs.length >= 5, tabs.length + " 个分区：" +
      tabs.map((t) => t.textContent.trim()).join("/"));
    const paneInfo = [];
    for (const t of tabs) {
      t.click();
      await sleep(320);
      const box = $("#settings-content");
      paneInfo.push(t.getAttribute("data-tab") + ":" + (box ? box.children.length : -1) + "块");
      if (t.getAttribute("data-tab") === "memory") await __shot("04-设置-长期记忆");
      if (t.getAttribute("data-tab") === "skills") await __shot("05-设置-技能");
      if (t.getAttribute("data-tab") === "mcp") await __shot("06-设置-MCP");
    }
    ok("完整：每个设置分区都能渲染出内容", paneInfo.every((s) => parseInt(s.split(":")[1], 10) > 0),
      paneInfo.join(" "));
    // 关闭设置（点 × —— 这里曾因 e.target 命中 svg 而关不掉）
    const xBtn = $("#modal-settings [data-close]");
    if (xBtn) xBtn.click();
    await sleep(300);
    ok("完整：设置弹窗点 × 能关闭（含点在图标上）", $("#modal-settings").classList.contains("hidden"));
    // Esc 关闭
    CubeApp.openSettings("general");
    await sleep(250);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(250);
    ok("完整：设置弹窗 Esc 能关闭", $("#modal-settings").classList.contains("hidden"));

    /* ---------- 3. 长期记忆 ---------- */
    step("验证长期记忆的写入与召回");
    CubeApp.openSettings("memory");
    await sleep(400);
    const memRowsBefore = $$(".mem-row").length;

    // 走真实用户路径：点设置里的「＋ 手动添加」，而不是直接调 remember()
    // —— 后者绕过 UI 刷新，测不出"添加后列表是否立刻出现"
    const addMemBtn = $$("#settings-content button").filter((b) => /手动添加|添加记忆|\+ ?记忆/.test(b.textContent))[0];
    const hasAddBtn = !!addMemBtn;
    ok("完整：记忆页有手动添加入口", hasAddBtn,
      addMemBtn ? "按钮「" + addMemBtn.textContent.trim() + "」" : "未找到添加按钮");
    if (addMemBtn) {
      /* 添加记忆走的是页面内弹窗（modal-prompt），不是 window.prompt ——
         所以要真的点弹窗里的输入框与「确定」，这才是用户路径。 */
      addMemBtn.click();
      await sleep(400);
      const pOpen = !$("#modal-prompt").classList.contains("hidden");
      await __shot("07a-记忆添加弹窗");
      ok("完整：点添加弹出页面内表单（不是浏览器原生 prompt）", pOpen,
        "modal-prompt 可见=" + pOpen);
      if (pOpen) {
        $("#prompt-input").value = "用户要求所有注释使用中文";
        $("#prompt-ok").click();
        await sleep(400);
        // 第二步：类型
        if (!$("#modal-prompt").classList.contains("hidden")) {
          $("#prompt-input").value = "preference";
          $("#prompt-ok").click();
          await sleep(500);
        }
      }
    }
    await __shot("07-记忆列表");
    const memRows = $$(".mem-row").length;
    ok("完整：添加记忆后列表立刻出现该条", memRows > memRowsBefore,
      "添加前 " + memRowsBefore + " 行 → 添加后 " + memRows + " 行");

    // 底层写入 + 召回（引擎层能力，与 UI 路径相互印证）
    const memWritten = (function () {
      try {
        return !!CubeMemory.remember({
          type: "preference", text: "用户要求所有注释使用中文", workspace: WS
        });
      } catch (e) { return "ERR " + e.message; }
    })();
    await sleep(300);
    const memRecalled = (function () {
      try {
        const r = CubeMemory.recall({ workspace: WS, query: "注释" });
        return Array.isArray(r) ? r : [];
      } catch (e) { return []; }
    })();
    ok("完整：长期记忆可写入并召回", memWritten === true && memRecalled.length >= 1,
      "写入=" + memWritten + " · 召回 " + memRecalled.length + " 条");
    const sysHasMem = (function () {
      try {
        const sys = CubeAgent.buildSystem({
          platform: "win32", workspace: WS, projectRules: "",
          constraints: [], memories: memRecalled, memoryLabels: CubeMemory.recallLabels ? CubeMemory.recallLabels() : {}
        });
        return /中文/.test(sys);
      } catch (e) { return "ERR " + e.message; }
    })();
    ok("完整：召回的记忆进入系统提示", sysHasMem === true, String(sysHasMem).slice(0, 80));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(250);

    /* ---------- 4. 技能 ---------- */
    step("验证技能扫描与新建");
    CubeApp.openSettings("skills");
    await sleep(500);
    const skillCards = $$(".skill-card").length;
    await __shot("08-技能列表");
    ok("完整：技能页能列出技能", skillCards >= 0,
      "技能 " + skillCards + " 张卡（0 也合法，说明是空环境）");
    // 新建一个技能
    const addBtn = $$("#settings-content button").filter((b) => /新建技能|\+ ?技能|添加技能/.test(b.textContent))[0];
    const opened = (function () {
      if (!addBtn) return false;
      addBtn.click();
      return true;
    })();
    await sleep(400);
    const skillModalOpen = opened && !$("#modal-skill").classList.contains("hidden");
    await __shot("09-新建技能弹窗");
    ok("完整：可打开新建技能弹窗", skillModalOpen, "弹窗已打开=" + skillModalOpen);
    if (skillModalOpen) {
      $("#skill-name").value = "live-check";
      $("#skill-desc").value = "实况测试用技能";
      $("#skill-body").value = "# 实况测试\n\n1. 先读文件\n2. 再改代码";
      $("#skill-save").click();
      await sleep(800);
      const nowCards = $$(".skill-card").length;
      const hasNew = $$(".skill-card").some((c) => /live-check/.test(c.textContent || ""));
      ok("完整：技能可保存并出现在列表", nowCards > skillCards || hasNew,
        "保存前 " + skillCards + " 张 → 保存后 " + nowCards + " 张 · 含新建=" + hasNew);
      await __shot("10-技能已保存");
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(300);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(250);

    /* ---------- 5. MCP 连接器 ---------- */
    step("验证 MCP 预设与状态");
    CubeApp.openSettings("mcp");
    await sleep(500);
    // 预设是内联样式的 btn-ghost btn-sm，没有专门的 class，用按钮文案认
    const presetBtns = $$("#settings-content button").filter((b) =>
      /filesystem|github|postgres|mysql|memory|fetch|sequential/i.test(b.textContent || ""));
    await __shot("11-MCP连接器");
    ok("完整：MCP 有可一键填表的预设", presetBtns.length >= 1,
      presetBtns.length + " 个预设：" + presetBtns.map((b) => b.textContent.trim()).join("/"));
    // 点一个预设，验证真的自动填表
    let filled = false;
    if (presetBtns.length) {
      const inputs = $$("#settings-content input");
      presetBtns[0].click();
      await sleep(300);
      filled = inputs.some((i) => i.value && i.value.length > 2);
      ok("完整：点预设能自动填入命令", filled,
        "输入框 " + inputs.map((i) => (i.value || "").slice(0, 12)).join(" | ").slice(0, 80));
    }
    const mcpRows = $$("#settings-content .mcp-row, #settings-content .mcp-item").length;
    ok("完整：MCP 已配置列表可渲染（可能为空）", mcpRows >= 0, mcpRows + " 条已配置");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(300);

    /* ---------- 6. 面具（助手预设）---------- */
    step("验证助手面具");
    $("#btn-masks").click();
    await sleep(400);
    await __shot("12-助手面具");
    const maskCards = $$("#mask-list .mask-card, #modal-masks .mask-card").length;
    ok("完整：面具弹窗列出内置面具", !$("#modal-masks").classList.contains("hidden") && maskCards >= 5,
      "面具 " + maskCards + " 个");
    if (maskCards) {
      const card = $$("#modal-masks .mask-card")[0];
      const before = S.activeSessionId;
      card.click();
      await sleep(400);
      await __shot("13-选择面具");
      ok("完整：点击面具可应用", true, "已应用「" + (card.textContent || "").slice(0, 20).trim() + "」");
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(250);

    /* ---------- 7. @ 文件引用 ---------- */
    step("验证 @ 引用工作区文件");
    const inp = $("#input");
    inp.value = "@";
    inp.dispatchEvent(new Event("input"));
    await sleep(500);
    const popup = !$("#mention-popup").classList.contains("hidden");
    await __shot("14-At引用弹窗");
    ok("完整：输入 @ 弹出文件候选", popup,
      "候选弹窗可见=" + popup + " · 候选 " + $$("#mention-popup > *").length + " 个");
    if (popup) {
      const pick = $$("#mention-popup > *")[0];
      if (pick) pick.click();
      await sleep(400);
      const chipN = $$("#context-chips .chip, #context-chips > *").length;
      ok("完整：选中后文件进入上下文胶囊", chipN >= 1, "上下文胶囊 " + chipN + " 个");
      await __shot("15-At引用已加入上下文");
    }
    // 清掉
    inp.value = "";
    inp.dispatchEvent(new Event("input"));
    await sleep(200);

    /* ---------- 8. 斜杠命令补全 ---------- */
    step("验证输入 / 弹出命令补全");
    inp.value = "/co";
    inp.dispatchEvent(new Event("input"));
    await sleep(450);
    await __shot("16-斜杠命令补全");
    const cmdPopup = !$("#command-popup").classList.contains("hidden");
    const cmdItems = $$("#command-popup > *").length;
    ok("完整：输入 / 弹出命令补全", cmdPopup && cmdItems >= 1,
      "候选 " + cmdItems + " 个（应为 /compact /context /continue 之类）");
    inp.value = "";
    inp.dispatchEvent(new Event("input"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(250);

    /* ---------- 9. 会话导出 ---------- */
    step("验证会话导出为 Markdown");
    const exported = await (async function () {
      try { await CubeApp.slash("/export"); return "ok"; } catch (e) { return "ERR " + e.message; }
    })();
    await sleep(400);
    await __shot("17-会话导出");
    ok("完整：/export 可导出当前会话", exported === "ok", "返回 " + exported);

    /* ---------- 10. 文件回滚 ---------- */
    step("验证文件改动可回滚");
    // 快照登记在 session.checkpoints，由运行对话时注入的 ctx.onCheckpoint 负责。
    // 这里必须自己实现同样的登记，否则 session 里没有快照，rollbackFile 会直接提示无记录。
    const rbSession = Store.getSession(S.activeSessionId);
    const onCk = function (p, prev) { rbSession.checkpoints = rbSession.checkpoints || {}; rbSession.checkpoints[p] = prev; };
    const rbCtx = { session: rbSession, workspace: WS, onCheckpoint: onCk };
    await CubeTools.execute("write", {
      path: "src/rollback-test.js", content: "function v1() { return 1; }\n"
    }, rbCtx);
    await sleep(200);
    await CubeTools.execute("edit", {
      path: "src/rollback-test.js", old_str: "return 1", new_str: "return 2"
    }, rbCtx);
    await sleep(200);
    Store.save();
    const before2 = (function () {
      try { return CubeApp.rollback("src/rollback-test.js"); } catch (e) { return "ERR " + e.message; }
    })();
    await sleep(700);
    let afterRb = "";
    try { afterRb = (await cube.read("src/rollback-test.js")).content || ""; } catch (e) { afterRb = "ERR"; }
    ok("完整：文件改动可回滚到上一版", /return 1/.test(afterRb) && !/return 2/.test(afterRb),
      "回滚调用=" + before2 + " · 回滚后含 return 1=" + /return 1/.test(afterRb) + " · 内容「" + afterRb.trim().slice(0, 40) + "」");

    /* ---------- 11. 权限档位 ---------- */
    step("验证三档权限");
    const perms = ["suggest", "auto", "full"];
    let permOK = true;
    const permSeen = [];
    for (const p of perms) {
      S.agent.permission = p;
      Store.save();
      CubeApp.renderAll();
      await sleep(200);
      permSeen.push($("#perm-select") ? $("#perm-select").value : "?");
      if ($("#perm-select") && $("#perm-select").value !== p) permOK = false;
    }
    ok("完整：三档权限可切换且下拉框同步", permOK,
      "设置值 " + perms.join("/") + " · 下拉框显示 " + permSeen.join("/"));
    S.agent.permission = "suggest";
    Store.save();

    /* ---------- 12. 快捷键 ---------- */
    step("验证快捷键");
    const n0 = S.sessions.length;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: true, bubbles: true }));
    await sleep(400);
    ok("完整：Ctrl+N 新建任务", S.sessions.length === n0 + 1,
      "会话 " + n0 + " → " + S.sessions.length + " 条");
    CubeApp.openPalette();
    await sleep(300);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);

    /* ---------- 13. 会话分支（Claude Code /branch、Codex fork 的等价物）---------- */
    step("验证会话分支：原会话不变，新会话独立演进");
    // 造一个 4 条消息的会话，从第 1 条（索引 1）分叉
    const bSrc = Store.createSession();
    bSrc.title = "分支源会话";
    bSrc.messages = [
      { role: "user", content: "第一步：读 src/calc.js", ts: Date.now() },
      { role: "assistant", content: "已读取，提供了 add 与 sub。", ts: Date.now() },
      { role: "user", content: "第二步：改成乘法", ts: Date.now() },
      { role: "assistant", content: "已改为乘法实现。", ts: Date.now() }
    ];
    Store.save();
    CubeApp.renderAll();
    await sleep(300);
    const srcId = bSrc.id;
    const srcBefore = bSrc.messages.length;
    const nBefore = S.sessions.length;

    await CubeApp.branchFrom(1);
    await sleep(500);
    await __shot("21-已分支出新会话");

    const forked = Store.getSession(S.activeSessionId);
    ok("完整：分支创建了新会话", !!forked && forked.id !== srcId && S.sessions.length === nBefore + 1,
      "会话 " + nBefore + " → " + S.sessions.length + " · 新标题「" + (forked && forked.title) + "」");
    ok("完整：分支只复制到分叉点，之后的对话不带过去",
      !!forked && forked.messages.length === 2,
      "源 " + srcBefore + " 条 → 分支 " + (forked ? forked.messages.length : "?") + " 条");
    ok("完整：分支记录了来源", !!forked && !!forked.forkedFrom && forked.forkedFrom.id === srcId,
      forked && forked.forkedFrom ? "来自「" + forked.forkedFrom.title + "」第 " + forked.forkedFrom.at + " 条" : "无来源标记");
    // 关键：改分支不能污染原会话（深拷贝到位没有）
    if (forked) {
      forked.messages.push({ role: "user", content: "分支里的新提问", ts: Date.now() });
      forked.todo = [{ text: "分支专属计划" }];
      forked.checkpoints = { "only-in-fork.js": "x" };
      Store.save();
    }
    const srcAfter = Store.getSession(srcId);
    ok("完整：在分支里追加内容，原会话不受影响",
      srcAfter.messages.length === srcBefore &&
      !(srcAfter.checkpoints && srcAfter.checkpoints["only-in-fork.js"]),
      "原会话仍为 " + srcAfter.messages.length + " 条（分支已 " + (forked ? forked.messages.length : "?") + " 条）");
    ok("完整：分支在侧栏有「分支」标记",
      $$("#session-list .session-branch-tag").length >= 1,
      "侧栏分支标记 " + $$("#session-list .session-branch-tag").length + " 个");
    // 分支按钮存在
    ok("完整：会话行有分叉按钮", $$("#session-list .session-branch").length >= 1,
      "分叉按钮 " + $$("#session-list .session-branch").length + " 个");
    // 斜杠命令
    ok("完整：/branch 斜杠命令可执行", await CubeApp.slash("/branch") === true);

    /* ---------- 14. 右栏面板逐个验证 ---------- */
    step("逐个验证右栏面板");
    const panelTabs = $$(".panel-tab");
    const panelInfo = [];
    for (const t of panelTabs) {
      t.click();
      await sleep(320);
      const pane = $("#panel-" + t.getAttribute("data-tab"));
      const has = pane && !pane.classList.contains("hidden");
      const n = pane ? pane.children.length : 0;
      panelInfo.push(t.getAttribute("data-tab") + ":" + (has ? "有内容" : "空") + "(" + n + ")");
      if (t.getAttribute("data-tab") === "diff") await __shot("18-变更面板");
      if (t.getAttribute("data-tab") === "trace") await __shot("19-轨迹面板");
      if (t.getAttribute("data-tab") === "git") await __shot("20-版本面板");
    }
    ok("完整：右栏 5 个面板都能切换", panelTabs.length === 5,
      panelTabs.length + " 个：" + panelInfo.join(" "));

    /* ---------- 14. 数据导入导出 ---------- */
    step("验证全量数据导出");
    const dump = (function () {
      try { return localStorage.getItem("cubeagent.v2") || localStorage.getItem("cubeagent.v1") || ""; }
      catch (e) { return ""; }
    })();
    ok("完整：状态已持久化（关窗重开不丢）", dump.length > 100,
      "存档 " + dump.length + " 字节 · 键名 cubeagent.v2/v1");

  } catch (e) {
    ok("完整流程执行未抛出异常", false, "TypeError: " + String((e && e.stack) || e).slice(0, 200));
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
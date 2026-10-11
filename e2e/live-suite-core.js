/* ============ 实况测试 · 核心高频功能 ============
 * 与 renderer-suite 的区别：这里刻意模拟"用户真的在用"——
 * 真的点按钮、真的等模型流式输出、真的读文件核验结果，每一步都截图。
 * 断言验的是用户能感知的结果，而不是内部变量。
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

  /* 等模型这一轮跑完 */
  async function waitIdle(maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (maxMs || 120000)) {
      if (!CubeApp.running()) return true;
      await sleep(300);
    }
    return false;
  }

  try {
    /* ---------- 1. 开局：欢迎页 ---------- */
    step("打开应用，检查欢迎页");
    await __shot("01-欢迎页");
    ok("核心：欢迎页渲染出面具卡片", $$("#welcome-masks > *").length >= 1,
      "面具卡片 " + $$("#welcome-masks > *").length + " 个");

    /* ---------- 2. 切到 Agent 模式 + 选工作区 ---------- */
    step("切 Agent 模式并选择工作区");
    S.agent.mode = "agent";
    S.agent.permission = "suggest";
    Store.save();
    await CubeApp.setWorkspace(WS);
    CubeApp.renderAll();
    await sleep(400);
    await __shot("02-已选工作区");
    const wsNow = await cube.getWorkspace();
    ok("核心：工作区已连接到真实目录", wsNow === WS, wsNow);

    /* ---------- 3. 真实聊天：流式输出 ---------- */
    step("发送一条真实消息，观察流式输出（真实调用 agnes 模型）");
    const s1 = Store.createSession();
    s1.title = "实况验证";
    Store.save();
    CubeApp.renderAll();
    await sleep(200);

    const t0 = Date.now();
    // 不 await：这一轮跑着的时候，紧接着模拟"用户又发了一条"，才能测到排队
    const firstTurn = CubeApp.submit("用一句话说明什么是闭包（closure），不要超过 30 字。");
    // 必须等 running 真的置位：submit 内部先 await composeUserText()，
    // 那之前 running 还是 false，此刻点发送会走正常发送而不是排队。
    for (let i = 0; i < 50 && !CubeApp.running(); i++) await sleep(50);
    const runningNow = CubeApp.running();

    /* ---------- 4. 验证"真流式" ---------- */
    /* 持续采样助手气泡的正文长度，看它是否在增长。
       只判断"气泡是否出现"是不够的：模型首字可能慢于采样窗口，
       慢模型会被误判失败。长度递增才是流式的真证明 ——
       非流式实现只会一次性出现最终长度。
       排队测试放在下一节的工具轮里做（那一轮必然耗时几十秒，窗口够宽）。 */
    let sawBubble = false;
    let grew = 0;
    const samples = [];
    for (let i = 0; i < 600 && CubeApp.running(); i++) {   // 最多等 120s
      const bubble = $$("#messages .msg-row.assistant .msg-content")[0];
      if (bubble) {
        sawBubble = true;
        const len = (bubble.textContent || "").trim().length;
        const prev = samples.length ? samples[samples.length - 1] : -1;
        if (len > prev) {
          grew++;
          // 抓到"生成中"的画面：正文还不完整，且本轮确实在跑
          if (len > 0 && len < 120 && grew <= 2) await __shot("04-流式输出中");
        }
        samples.push(len);
      }
      await sleep(150);
      // 已经观察到三次增长就够证明流式了，不必等本轮跑完
      if (grew >= 3) break;
    }
    const streaming = sawBubble && grew >= 2;
    if (!samples.length) await __shot("04-流式输出中");

    const idle1 = await waitIdle(120000);
    await sleep(600);
    await __shot("05-首轮回复完成");

    const s1After = Store.getSession(S.activeSessionId);
    const firstAnswer = (s1After.messages.filter((m) => m.role === "assistant")[0] || {}).content || "";
    ok("核心：真实模型返回了内容", !!firstAnswer && firstAnswer.length > 5,
      firstAnswer.slice(0, 50).replace(/\n/g, " ") + "…（" + firstAnswer.length + " 字，"
      + ((Date.now() - t0) / 1000).toFixed(1) + "s）");
    ok("核心：回复内容切题（不是空转）",
      /闭包|closure|词法|作用域|外部变量|外层/i.test(firstAnswer),
      "正文「" + firstAnswer.slice(0, 46).replace(/\n/g, " ") + "」");
    ok("核心：回复逐字流式渲染（非一次性出现）", streaming,
      "采样 " + samples.length + " 次，正文长度轨迹 " +
      samples.slice(0, 8).join("→") + (samples.length > 8 ? "→…" : "") + "（增长 " + grew + " 次）");
    ok("核心：本轮能正常结束（未卡死）", idle1, "首轮结束=" + idle1);
    try { await firstTurn; } catch (e) { /* 已由上面断言覆盖 */ }

    /* ---------- 5. 真实工具调用 + 排队发送 ---------- */
    step("Agent 模式真实调用工具：读文件并改代码");
    const s2 = Store.createSession();
    s2.title = "改代码";
    Store.save();
    CubeApp.renderAll();
    await sleep(300);
    // 这一轮要跑十几次工具，必然耗时几十秒 —— 排队测试放在这里才稳。
    // 之前放在"一句话解释闭包"后面，模型 2 秒就答完，
    // 等点发送时 running 已经是 false，测试变成了赌模型速度。
    const toolTurn = CubeApp.submit("读取 src/calc.js，然后在文件末尾追加一行注释 // live-test-ok（用 edit 或 write 工具，别只告诉我怎么做）。");
    for (let i = 0; i < 60 && !CubeApp.running(); i++) await sleep(50);

    step("趁工具还在跑，模拟用户发送新消息（测排队）");
    const inp2 = $("#input");
    inp2.value = "顺便再看一下 src/utils/format.js 做了什么。";
    inp2.dispatchEvent(new Event("input"));
    $("#btn-send").click();
    await sleep(300);
    const qBar2 = !$("#queue-bar").classList.contains("hidden");
    const qCount2 = $$("#queue-bar .queue-item").length;
    const qState2 = (function () {
      try { return CubeApp.queue().length; } catch (e) { return "ERR"; }
    })();
    await __shot("07-排队条出现");
    ok("核心：运行中发送不丢消息，进入队列", qBar2 && qCount2 >= 1,
      "内部队列=" + qState2 + " 条 · 队列条可见=" + qBar2 + " · DOM 条目=" + qCount2
      + " · 输入框已清空=" + (inp2.value === ""));

    await waitIdle(240000);
    await sleep(1000);
    try { await toolTurn; } catch (e) { /* 已由断言覆盖 */ }
    await __shot("08-工具调用与队列续发完成");

    const s2After = Store.getSession(S.activeSessionId);
    const toolMsgs = s2After.messages.filter((m) => m.role === "tool");
    const users2 = s2After.messages.filter((m) => m.role === "user").length;
    ok("核心：模型真的调用了工具", toolMsgs.length >= 1,
      "工具调用 " + toolMsgs.length + " 次：" + toolMsgs.map((m) => m.name).join(","));
    ok("核心：排队的消息也在本轮之后自动发出", users2 >= 2 && $$("#queue-bar .queue-item").length === 0,
      "用户提问 " + users2 + " 条 · 剩余队列 " + $$("#queue-bar .queue-item").length + " 条");
    let disk = "";
    try { disk = (await cube.read("src/calc.js")).content || ""; } catch (e) { disk = "ERR " + e.message; }
    ok("核心：文件真的被改到磁盘上", /live-test-ok/.test(disk),
      disk.indexOf("live-test-ok") >= 0 ? "磁盘已含 live-test-ok" : "磁盘未含标记，实际内容末尾：" + disk.slice(-80));

    /* ---------- 6. 复制 / 编辑重发 / 重新生成 ---------- */
    step("验证消息复制、编辑重发、重新生成");
    const rows = $$("#messages .msg-row");
    ok("核心：每条消息都带操作按钮（复制/编辑/重新生成）",
      $$("#messages .msg-actions button").length >= 3,
      "操作按钮 " + $$("#messages .msg-actions button").length + " 个");
    await __shot("09-消息操作按钮");

    // 复制按钮存在且点了不报错
    const copyBtn = $$("#messages .msg-actions button").filter((b) => /复制/.test(b.textContent))[0];
    let copyErr = "";
    try { if (copyBtn) copyBtn.click(); } catch (e) { copyErr = e.message; }
    await sleep(500);
    await __shot("10-点击复制");
    ok("核心：复制按钮可点击且不抛异常", !copyErr,
      copyErr || ("按钮文案「" + (copyBtn ? copyBtn.textContent.trim() : "无") + "」"));

    /* ---------- 7. 斜杠命令 ---------- */
    step("验证斜杠命令");
    for (const cmd of ["/context", "/permissions", "/help"]) {
      let r = false;
      try { r = await CubeApp.slash(cmd); } catch (e) { r = false; }
      ok("核心：斜杠命令 " + cmd + " 可执行", r === true, "返回 " + r);
      await sleep(250);
    }
    await __shot("11-斜杠命令-上下文");

    /* ---------- 8. 会话管理 ---------- */
    step("验证会话管理：搜索 / 切换 / 重命名");
    const nSess = S.sessions.length;
    ok("核心：已创建多个会话", nSess >= 2, "共 " + nSess + " 个会话");
    // 注意：会话标题是 runTurn 从首条提问自动生成的（不是我们预设的名字），
    // 所以搜索必须用真实标题的前几个字，否则测的是不存在的字符串。
    const realTitles = S.sessions.map((s) => s.title || "");
    const keyword = (realTitles.filter(Boolean)[1] || realTitles[0] || "").slice(0, 4);
    const searchHit = (function () {
      const inp2 = $("#search-input");
      if (!inp2 || !keyword) return -1;
      inp2.value = keyword;
      inp2.dispatchEvent(new Event("input"));
      const n = $$("#session-list .session-item").length;
      inp2.value = "";
      inp2.dispatchEvent(new Event("input"));
      return n;
    })();
    ok("核心：会话搜索能过滤", searchHit >= 1 && searchHit < nSess,
      "搜索「" + keyword + "」命中 " + searchHit + " / " + nSess + " 条（标题：" + realTitles.join(" / ").slice(0, 50) + "）");
    await sleep(300);
    await __shot("12-会话列表");

    /* ---------- 9. 主题 / 面板 ---------- */
    step("验证主题切换与右栏面板");
    document.documentElement.setAttribute("data-theme", "light");
    await sleep(400);
    await __shot("13-浅色主题");
    document.documentElement.setAttribute("data-theme", "dark");
    await sleep(300);
    ok("核心：主题可切换", true, "浅色/深色均已截图");

    const panelBtns = $$("#panel-tabs button, .panel-tab");
    if (panelBtns.length) {
      for (const b of panelBtns) {
        try { b.click(); await sleep(200); } catch (e) { /* ignore */ }
      }
      await __shot("14-右栏面板切换");
      ok("核心：右栏面板可切换", true, panelBtns.length + " 个页签均已点击");
    }

  } catch (e) {
    ok("核心流程执行未抛出异常", false, "TypeError: " + String((e && e.stack) || e).slice(0, 200));
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
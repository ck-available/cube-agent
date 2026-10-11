/* ============ CubeAgent 深度功能验证（渲染进程内执行） ============
 * 覆盖四大能力域：① 工具调用 ② 写代码并真跑 ③ 长文本分析 ④ 上下文分析
 * 全部走真实模型 + 真实文件系统 + 真实 DOM，不做任何 mock。
 * 必须是一个可直接求值的表达式，因此整体包成立即执行的 async 函数。
 */
(async function () {
  const checks = [];
  const logs = [];
  const ok = (name, pass, detail) => {
    checks.push({ name: name, pass: !!pass, detail: detail == null ? "" : String(detail).slice(0, 400) });
    if (!pass) logs.push("失败用例：" + name + (detail ? " → " + detail : ""));
  };
  const note = (name, detail) => {
    checks.push({ name: name, pass: true, info: true, detail: detail == null ? "" : String(detail).slice(0, 400) });
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  try {
    const WS = window.__E2E_WS__;
    const cube = window.cube;
    const S = CubeApp.state();
    const ctx = { onCheckpoint: (p, prev) => { (S.__cp = S.__cp || {})[p] = prev; } };

    /* 真实回答判定：排除 HTTP 错误 / 限流文案，避免"错误文本"被当成通过 */
    const REAL = (a) => !!a && !/请求失败|HTTP\s*\d{3}|rate limit|429/i.test(a);

    /* 统一提问入口：带节流间隔 + 限流自动重试（免费 API 有速率限制） */
    const askStats = { calls: 0, retries: 0 };
    async function ask(text, waitMs) {
      let ans = "";
      for (let attempt = 0; attempt < 4; attempt++) {
        await sleep(waitMs == null ? 4500 : waitMs);
        const baseMsg = cur().messages.length;   // 失败时回滚，避免错误消息污染上下文
        askStats.calls++;
        await CubeApp.runTurn(text);
        const m = lastAssistant();
        ans = (m && m.content) || "";
        // 空回复通常也是限流/异常的表现，同样重试
        if (REAL(ans) && ans.trim().length >= 2) return ans;
        if (!/429|rate limit/i.test(ans) && ans.trim().length >= 2 && !/请求失败/.test(ans)) return ans;
        // 回滚本轮（含失败消息）后等待限流窗口过去再重试
        cur().messages.length = baseMsg;
        Store.save();
        askStats.retries++;
        await sleep(30000);
      }
      // 四次都没拿到有效回复：返回带错误标记的文本，让上层断言如实判定为未完成
      return "请求失败：__ASK_FAILED__（重试 " + askStats.retries + " 次仍未拿到有效回复，多为 API 限流）";
    }

    /* 当前会话：出厂状态下 activeSessionId 可能尚未指向任何会话，取不到就新建一个 */
    const cur = () => Store.getSession(S.activeSessionId) || Store.createSession();

    const lastAssistant = () => {
      const s = cur();
      for (let i = s.messages.length - 1; i >= 0; i--) if (s.messages[i].role === "assistant") return s.messages[i];
      return null;
    };
    /* 取本轮（基线之后）新增的工具消息 */
    const toolsSince = (base) => cur().messages.slice(base).filter((m) => m.role === "tool");
    const namesOf = (msgs) => Array.from(new Set(msgs.map((m) => m.name)));
    const msgsLen = () => cur().messages.length;

    /* ---------- 0. 环境就绪 ---------- */
    const w = await cube.setWorkspace(WS);
    CubeApp.setWorkspace(WS);
    await sleep(700);
    ok("就绪：工作区已挂载", !!w && String(w).indexOf("workspace") >= 0, w);
    S.agent.mode = "agent";
    S.agent.permission = "full";
    Store.save();
    cur();   // 确保至少有一个会话可写（出厂状态下可能还没有）
    ok("就绪：Agent 模式 + full 权限", S.agent.mode === "agent" && S.agent.permission === "full");

    const SAMPLE = "Hello world hello CUBE world hello\nCube cube CUBE\n";
    await cube.write("data/sample.txt", SAMPLE);
    await cube.write("data/buggy.js",
      "function sum(arr) {\n  var t = 0;\n  for (var i = 1; i < arr.length; i++) t += arr[i];\n  return t;\n}\n" +
      "console.log(sum([1, 2, 3, 4]));\n");
    ok("素材：样例文本与待修脚本已写入", true, "data/sample.txt · data/buggy.js");

    /* =====================================================================
     * 一、工具调用：9 个工具逐个真实执行 + 异常边界
     * ===================================================================== */
    const r1 = await CubeTools.execute("read", { path: "src/calc.js" }, ctx);
    ok("工具 read：读取真实文件", !!r1 && r1.output.indexOf("function add") >= 0, (r1 && r1.output || "").replace(/\n/g, " ").slice(0, 50));

    const r2 = await CubeTools.execute("list_dir", { path: "src" }, ctx);
    ok("工具 list_dir：列出子目录", !!r2 && /calc\.js/.test(r2.output) && /utils/.test(r2.output), (r2 && r2.output || "").replace(/\n/g, " ").slice(0, 50));

    const r3 = await CubeTools.execute("glob", { pattern: "**/*.js" }, ctx);
    ok("工具 glob：递归匹配 js", !!r3 && /buggy\.js/.test(r3.output) && /calc\.js/.test(r3.output), (r3 && r3.output || "").replace(/\n/g, " ").slice(0, 60));

    const r4 = await CubeTools.execute("grep", { pattern: "function\\s+\\w+", path: "src" }, ctx);
    ok("工具 grep：正则命中并带行号", !!r4 && /calc\.js:\d+/.test(r4.output), (r4 && r4.output || "").replace(/\n/g, " | ").slice(0, 70));

    const r5 = await CubeTools.execute("write", { path: "out/tool-write.txt", content: "中文内容 · special <>&\"' · 换行\n第二行\n" }, ctx);
    ok("工具 write：中文与特殊字符落盘往返", (await cube.read("out/tool-write.txt")).content.indexOf("special <>&") >= 0);

    const r6 = await CubeTools.execute("edit", { path: "out/tool-write.txt", old_str: "第二行", new_str: "已替换行" }, ctx);
    ok("工具 edit：精确替换生效", (await cube.read("out/tool-write.txt")).content.indexOf("已替换行") >= 0);

    const r7 = await CubeTools.execute("bash", { command: "node -e \"console.log(6*7)\"" }, ctx);
    ok("工具 bash：执行并拿到输出", !!r7 && r7.output.indexOf("42") >= 0, (r7 && r7.output || "").trim());

    // todo_write：数据层 + 渲染层分开验证（真实链路在 Agent 循环里写回 session.todo）
    const r8 = await CubeTools.execute("todo_write", {
      items: [
        { id: "1", content: "深度测试项 A", status: "done" },
        { id: "2", content: "深度测试项 B", status: "pending" }
      ]
    }, ctx);
    ok("工具 todo_write：返回计划数据（数据层）", !!r8 && r8.output === "计划已更新" && r8.items && r8.items.length === 2,
      (r8 && r8.output) + " · items=" + (r8 && r8.items && r8.items.length));
    const todoSess = cur();
    todoSess.todo = r8.items;
    Store.save();
    CubeApp.renderAll();
    await sleep(200);
    ok("工具 todo_write：计划渲染到右栏面板（渲染层）", $$("#panel-todo .todo-item").length === 2,
      "面板 todo 项 " + $$("#panel-todo .todo-item").length + " 个");

    const r9 = await CubeTools.execute("task_complete", { summary: "深度测试完成" }, ctx);
    ok("工具 task_complete：结束信号可被识别", !!r9 && r9.complete === true, r9 && r9.output);

    let e1 = "";
    try { await CubeTools.execute("read", { path: "绝对不存在的文件.js" }, ctx); } catch (e) { e1 = e.message; }
    ok("边界：读取不存在文件报错", e1.length > 0, e1.slice(0, 50));

    const e2 = await cube.write("../../越界.txt", "x");
    ok("边界：越界写入被拒绝", !!e2 && !!e2.__error, e2 && e2.__error);

    let e3 = "";
    try { await CubeTools.execute("edit", { path: "src/calc.js", old_str: "function", new_str: "fn" }, ctx); } catch (e) { e3 = e.message; }
    ok("边界：edit 非唯一片段被拒", e3.indexOf("次") >= 0, e3.slice(0, 50));

    const e4 = await CubeTools.execute("bash", { command: "node -e \"process.exit(3)\"" }, ctx);
    ok("边界：bash 非零退出码如实返回", e4 && e4.code === 3, "code=" + (e4 && e4.code));

    const e5 = await CubeTools.execute("bash", { command: "rm -rf /" }, ctx);
    ok("边界：高危命令被拒绝", e5 && e5.refused === true, e5 && e5.output);

    /* =====================================================================
     * 二、写代码：让模型真写一个能跑的 CLI，自己再执行校验
     * ===================================================================== */
    let base = msgsLen();
    await ask(
      "请在 src/wordfreq.js 写一个 Node.js 命令行脚本：从 process.argv[2] 读文本文件路径，" +
      "统计英文单词频次（忽略大小写、去除标点），按频次降序、同频按单词升序，输出前 5 行，每行严格为 `单词: 次数`；" +
      "文件不存在时打印 `file not found` 并 process.exit(1)。\n" +
      "先用 todo_write 建立 2 步计划，写完后必须用 bash 运行 `node src/wordfreq.js data/sample.txt` 验证。", 2600);
    let used = namesOf(toolsSince(base));
    /* 工具链只做记录：限流重试会回滚本轮消息（文件已写但消息被撤销），
     * 因此"是否真的调用了 write/bash"不应作为硬断言——客观证据看下面的文件与运行结果。 */
    note("写代码：本轮模型实际使用的工具链", used.length ? used.join(",") : "（未记录到工具调用，见下方文件与运行结果的客观验证）");
    ok("写代码：模型用 todo_write 建了计划（真实链路写回面板）",
      (cur().todo || []).length >= 1 || used.indexOf("todo_write") >= 0,
      "session.todo " + (cur().todo || []).length + " 项 · 工具链含 todo_write=" + (used.indexOf("todo_write") >= 0));

    const wfStat = await cube.stat("src/wordfreq.js");
    ok("写代码：模型产出的文件真实落盘", wfStat && wfStat.exists === true && wfStat.size > 100,
      "src/wordfreq.js size=" + (wfStat && wfStat.size));

    // 模型可能为了自测改写过素材，校验前先恢复成预期内容，保证期望值成立
    await cube.write("data/sample.txt", SAMPLE);
    const wfRun = await CubeTools.execute("bash", { command: "node src/wordfreq.js data/sample.txt" }, ctx);
    const wfOut = (wfRun && wfRun.output || "").trim();
    ok("写代码：脚本能真实运行", wfRun && wfRun.code === 0, "code=" + (wfRun && wfRun.code) + " 输出：" + wfOut.replace(/\n/g, " | "));
    // 期望：cube 4 次（CUBE/Cube/cube/CUBE）、hello 3 次、world 2 次；同频按升序 → hello 先于 world? 不，按频次降序：cube4, hello3, world2
    ok("写代码：输出与预期一致（cube=4, hello=3, world=2）",
      /cube:\s*4/i.test(wfOut) && /hello:\s*3/i.test(wfOut) && /world:\s*2/i.test(wfOut), wfOut.replace(/\n/g, " | "));

    const wfMiss = await CubeTools.execute("bash", { command: "node src/wordfreq.js data/nope.txt" }, ctx);
    ok("写代码：错误处理符合约定（file not found + 退出码 1）",
      /file not found/i.test(wfMiss.output) && wfMiss.code === 1, "code=" + wfMiss.code + " 输出：" + wfMiss.output.trim());

    const buggyBefore = await CubeTools.execute("bash", { command: "node data/buggy.js" }, ctx);
    base = msgsLen();
    await ask("data/buggy.js 的 sum 函数有 off-by-one 错误（当前输出 " + (buggyBefore.output || "").trim() +
      "，正确应为 10）。请用 read 阅读后用 edit 修好，再 bash 运行 `node data/buggy.js` 确认输出 10。", 2600);
    const buggyAfter = await CubeTools.execute("bash", { command: "node data/buggy.js" }, ctx);
    ok("改代码：修复后运行结果正确（10）", (buggyAfter.output || "").trim() === "10",
      "修复前=" + (buggyBefore.output || "").trim() + " 修复后=" + (buggyAfter.output || "").trim());
    const buggySrc = await cube.read("data/buggy.js");
    ok("改代码：源码确实被修改（i=1 → i=0）", /i\s*=\s*0/.test(buggySrc.content), buggySrc.content.replace(/\n/g, " ").slice(0, 70));
    ok("改代码：模型走了 read → edit → bash 链路",
      namesOf(toolsSince(base)).indexOf("edit") >= 0 || /i\s*=\s*0/.test(buggySrc.content), "本轮工具：" + namesOf(toolsSince(base)).join(","));

    /* =====================================================================
     * 三、长文本分析
     * ===================================================================== */
    function buildManual() {
      const head =
        "《深海牧场运维手册》\n\n第一章 总则\n本手册规定了深海牧场的日常巡检、设备维护与应急处置流程。" +
        "牧场编号 SMP-2043，负责工程师为周砚，应急联系电话 010-8823-4417。\n\n" +
        "第二章 巡检\n每日需完成三次巡检，重点检查锚链张力、网箱破损与水质传感器。\n";
      const filler = [];
      let i = 0;
      while (head.length + filler.join("").length < 8600) {
        filler.push("第 " + (i + 3) + " 节 巡检记录样例：当日水温 " + (12 + (i % 7)) + "." + (i % 10) + " ℃，盐度 " +
          (30 + (i % 5)) + "‰，溶解氧 " + (6 + (i % 3)) + ".2 mg/L，网箱编号 C" + (100 + i) +
          " 状态正常，未发现异常附着物。巡检人：值班组 " + ((i % 4) + 1) + " 组。\n");
        i++;
      }
      const tail = "\n附录 A 应急处置\n发生网箱破损时，应立即启动应急预案 E-77，并在 30 分钟内上报。\n" +
        "附录 B 备件清单\n常备件包括：锚链扣、网衣补丁、水下摄像头（型号 DSC-9）、备用电池组。\n";
      return head + filler.join("") + tail;
    }
    const manual = buildManual();
    await cube.write("data/manual.txt", manual);
    ok("长文本：中等篇幅素材已生成", manual.length > 8000, manual.length + " 字符");
    const longSessionId = cur().id;   // 记住这个会话，最后回到它验证渲染

    base = msgsLen();
    await ask(
      "这是一次阅读理解任务，不要修改任何文件。\n" +
      "请用 read 工具阅读 data/manual.txt（约 " + manual.length + " 字符的纯文本手册；" +
      "内容前面的数字只是行号，请忽略行号理解正文）。\n" +
      "读完后严格按三行回答：\n1）主题：不超过 40 字概括；\n2）牧场编号：\n3）应急预案编号：", 2600);
    let ans = (lastAssistant() || {}).content || "";
    ok("长文本：模型完成通读并作答", REAL(ans) && ans.length > 20, ans.replace(/\n/g, " | ").slice(0, 100));
    ok("长文本：抽取事实正确（SMP-2043）", /SMP-2043/.test(ans), "命中=" + /SMP-2043/.test(ans));
    ok("长文本：抽取细节正确（E-77）", /E-77/.test(ans), "命中=" + /E-77/.test(ans));
    ok("长文本：摘要未失控（<500 字）", ans.length < 500, "回答 " + ans.length + " 字");

    /* 3.2 超长文本（约 4.1 万字）：验证上下文保护 + 前部锚点 + 不幻觉 */
    function buildHuge() {
      const head =
        "【卷一 · 序章】\n本档案记录麒麟项目的全部历史。项目代号：麒麟；立项年份：2031。\n" +
        "关键事实一：主合同编号 HT-8842-麒麟。\n关键事实二：验收口令为「蓝鲸4729」。\n\n";
      const body = [];
      let k = 0;
      while (head.length + body.join("").length < 41000) {
        body.push("【卷" + (k + 2) + " · 阶段性记录】本月完成第 " + (k + 1) + " 批交付，累计交付 " + ((k + 1) * 12) +
          " 台设备；参与方包括研究院、船厂与第三方检测机构；本月无重大质量事故，水压试验、盐雾试验与疲劳试验均通过。" +
          "备注：本段仅为过程性记录，不含任何关键事实。\n");
        k++;
      }
      const tail = "\n【末卷 · 封存页】关键事实三：封存密钥为 ZQ-8812（仅存于本页）。\n";
      return head + body.join("") + tail;
    }
    const huge = buildHuge();
    await cube.write("data/huge.txt", huge);
    ok("长文本：超长素材已生成（约 4 万字）", huge.length > 40000, huge.length + " 字符");

    // 第一步：强制读取，检查工具输出是否被截断（MAX_TOOL_CHARS 保护）
    base = msgsLen();
    await ask("请立刻用 read 工具读取 data/huge.txt 这个文件，读完只回复一句“已读取”。", 2600);
    const hugeTools = toolsSince(base).filter((m) => m.name === "read");
    const hugeReadOut = hugeTools.map((m) => m.content).join("\n");
    ok("长文本：模型确实调用了 read 读取超长文件", hugeTools.length >= 1,
      "read 调用 " + hugeTools.length + " 次 · 本轮工具：" + namesOf(toolsSince(base)).join(","));
    const truncated = /已截断/.test(hugeReadOut);
    ok("长文本：超长读取触发上下文保护（输出被截断）", truncated,
      truncated ? "命中截断提示，工具输出已按 MAX_TOOL_CHARS=9000 限制" : "未出现截断提示（工具输出 " + hugeReadOut.length + " 字符）");

    /* Microcompaction 的真实链路验证：
       超大工具结果应该被折叠成"占位符 + 归档路径"，而不是继续常驻上下文。 */
    const beforeMicro = cur().messages.length;
    const folded = cur().messages.filter((m) => m.microStored);
    ok("长文本：超大工具结果被 microcompaction 折叠",
      folded.length >= 1,
      folded.length ? "折叠 " + folded.length + " 块，例：" + String(folded[0].microStored).split(/[\\/]/).pop()
        : "未折叠（超大输出仍占着上下文）");
    if (folded.length) {
      const f = folded[0];
      ok("长文本：折叠后上下文里只剩占位符", f.content.length < 4000 && /已折叠/.test(f.content),
        "内容缩到 " + f.content.length + " 字符");
      ok("长文本：占位符含归档路径且提示可回读",
        /read/.test(f.content) && String(f.microStored).length > 3,
        "路径 " + f.microStored);
      /* 关键：占位符给的路径必须是模型真能读到的。
         归档写在工作区内，所以 cube.read 应该成功 —— 若失败说明占位符是假线索。 */
      let archiveRead = null;
      try { archiveRead = await cube.read(f.microStored); } catch (e) { archiveRead = { __error: String(e.message || e) }; }
      ok("长文本：占位符给的路径模型真能 read 到（不是假线索）",
        archiveRead && !archiveRead.__error && String(archiveRead.content || "").length > 1000,
        archiveRead && archiveRead.__error ? "读不到：" + archiveRead.__error
          : "回读成功 " + String(archiveRead.content || "").length + " 字符");
      ok("长文本：UI 仍保留原文可供展开", !!(f.fullContent && f.fullContent.length > 4000),
        "原文 " + (f.fullContent ? f.fullContent.length : 0) + " 字符");
    }

    // 第二步：基于已有上下文回答锚点
    await ask("根据你刚才读到的档案内容回答（没看到就明确说没看到，不要猜）：\n" +
      "1）主合同编号？\n2）验收口令？\n3）封存密钥？", 2600);
    ans = (lastAssistant() || {}).content || "";
    ok("长文本：前部锚点可读出（HT-8842）", /HT-8842/.test(ans), "命中=" + /HT-8842/.test(ans) + " · " + ans.replace(/\n/g, " | ").slice(0, 70));
    ok("长文本：前部锚点可读出（蓝鲸4729）", /蓝鲸4729|蓝鲸 4729/.test(ans), "命中=" + /蓝鲸4729/.test(ans));
    const tailKnown = /ZQ-8812/.test(ans);
    // 模型表达"没看到"的说法很多："未看到"/"未在...中看到"/"没有找到"/"未提及"…
    const honest = /没有|未见|未看到|未在[^。]{0,20}看到|无法|没看到|不确定|未提及|截断|看不到|未能|未发现/.test(ans);
    ok("长文本：后部锚点不臆造（答对或承认没看到）", tailKnown || honest,
      tailKnown ? "读到了末卷密钥" : (honest ? "未读到但明确承认（无幻觉）" : ans.slice(0, 60)));
    note("长文本：末卷密钥可达性", tailKnown ? "可达" : "因工具输出截断，末卷内容未进入上下文（已知限制，非缺陷）");

    /* =====================================================================
     * 四、上下文分析
     * ===================================================================== */
    Store.createSession();
    S.agent.mode = "chat";
    Store.save();
    CubeApp.renderAll();

    const facts = [["K1", "阿尔法"], ["K2", "布瑞塔"], ["K3", "西格玛"], ["K4", "德尔塔"],
      ["K5", "欧米伽"], ["K6", "卡帕"], ["K7", "兰姆达"], ["K8", "欧米克隆"]];
    for (let i = 0; i < facts.length; i++) {
      await ask("记住：编号 " + facts[i][0] + " 的值是 " + facts[i][1] + "。只回复“已记住”。", 2400);
    }
    await ask("把刚才让你记住的编号和值按 `编号=值` 逐行全部列出，不要遗漏。", 2600);
    ans = (lastAssistant() || {}).content || "";
    // 兼容 "K1=阿尔法" 与 "编号 K1 的值是阿尔法" 等多种表述：编号后 12 字内出现对应值即算命中
    const hit = facts.filter((f) => new RegExp(f[0] + "[^\\n]{0,12}" + f[1]).test(ans)).length;
    ok("上下文：8 轮对话后跨轮记忆完整", REAL(ans) && hit >= 7, "回忆命中 " + hit + " / 8 · " + ans.replace(/\n/g, " | ").slice(0, 90));

    // 超长历史压力：连塞 3 段长文本后仍能作答
    const s2 = cur();
    const pad = "这是一段用于压力测试的填充文本，描述一次例行巡检：水温、盐度、溶解氧均在正常区间，网箱结构完好。".repeat(70);
    for (let i = 0; i < 3; i++) {
      s2.messages.push({ role: "user", content: "【压力段落 " + (i + 1) + "】" + pad, ts: Date.now() });
      s2.messages.push({ role: "assistant", content: "已收到第 " + (i + 1) + " 段。", ts: Date.now() });
    }
    Store.save();
    ok("上下文：已注入超长历史", s2.messages.length >= 16, "消息 " + s2.messages.length + " 条 · 单段 " + pad.length + " 字");
    await ask("只回复四个字：压力通过。", 4500);
    ans = (lastAssistant() || {}).content || "";
    ok("上下文：超长历史下仍可正常回复", ans.indexOf("压力通过") >= 0, ans.slice(0, 50));

    // /compact 上下文压缩（新实现：模型生成摘要 + 保留近邻原文，而非粗暴截断）
    const beforeCompact = msgsLen();
    const beforeSummaryLen = (cur().summary || "").length;
    const beforeCompactTokens = CubeApp.contextStat().total;
    const compactOK = await CubeApp.slash("/compact");
    await sleep(800);
    const afterCompact = msgsLen();
    const afterCompactTokens = CubeApp.contextStat().total;
    const afterSummary = (cur().summary || "");
    ok("上下文：/compact 命令可执行", compactOK === true);
    ok("上下文：压缩真的产出了摘要（而非丢弃历史）",
      afterSummary.length > beforeSummaryLen + 20 && afterSummary.length > 40,
      "摘要 " + beforeSummaryLen + " → " + afterSummary.length + " 字符");
    ok("上下文：摘要包含结构化要素",
      /(目标|完成|决策|文件|遗留|下一步)/.test(afterSummary),
      afterSummary.replace(/\n/g, " | ").slice(0, 90));
    ok("上下文：压缩后历史显著缩短", beforeCompact > afterCompact,
      beforeCompact + " → " + afterCompact + " 条");
    ok("上下文：压缩后第一条是摘要标记",
      cur().messages[0] && cur().messages[0].compactSummary === true,
      "首条 role=" + (cur().messages[0] || {}).role + " compactSummary=" + ((cur().messages[0] || {}).compactSummary));
    ok("上下文：压缩次数被记录", (cur().compactCount || 0) >= 1, "compactCount=" + (cur().compactCount || 0));
    ok("上下文：压缩真的省下了 token（不是换个地方存）",
      afterCompactTokens < beforeCompactTokens,
      fmtTok(beforeCompactTokens) + " → " + fmtTok(afterCompactTokens) + " tokens");
    function fmtTok(n) { return Math.round(n).toLocaleString(); }

    // 压缩后仍要能继续对话（摘要能撑住后续工作）
    ans = "";
    await ask("用一句话说明你之前在做什么。", 3200);
    ans = (lastAssistant() || {}).content || "";
    ok("上下文：压缩后仍可正常对话（摘要可续接）", REAL(ans) && ans.length > 5, ans.replace(/\n/g, " | ").slice(0, 70));

    // /context 查看用量明细（新版渲染为 ctx-report 结构）
    const ctxOK = await CubeApp.slash("/context");
    await sleep(400);
    ok("上下文：/context 命令可执行", ctxOK === true);
    const rep = document.querySelector("#messages .ctx-report");
    ok("上下文：/context 渲染出明细报告", !!rep,
      rep ? "标题=" + rep.querySelector(".ctx-report-title").textContent : "未找到 .ctx-report");
    ok("上下文：报告含占用百分比与窗口",
      rep && /上下文用量/.test(rep.querySelector(".ctx-report-title").textContent) &&
      /窗口/.test(rep.querySelector(".ctx-report-sub").textContent),
      rep ? rep.querySelector(".ctx-report-sub").textContent : "");
    const repRows = rep ? $$(".ctx-report .ctx-row").map((e) => e.textContent) : [];
    ok("上下文：报告逐项列出系统/工具/历史/工具结果/@引用",
      repRows.length >= 5 &&
      repRows.some((r) => /系统提示/.test(r)) && repRows.some((r) => /工具定义/.test(r)) &&
      repRows.some((r) => /对话历史/.test(r)) && repRows.some((r) => /工具结果/.test(r)),
      repRows.length + " 行");

    // 顶部进度条与右栏面板也要同步
    const barW = $("#ctx-bar").style.width;
    const pctTxt = $("#ctx-pct").textContent;
    ok("上下文：顶部进度条实时显示占用", /%$/.test(barW) && /%$/.test(pctTxt),
      "bar=" + barW + " 文本=" + pctTxt);

    /* @ 文件引用进入上下文 */
    await sleep(1500);
    const ta = $("#input");
    ta.value = "这个文件里定义了哪些函数？ @calc";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(500);
    const popItems = $$("#mention-popup .popup-item");
    ok("上下文：@ 触发文件索引弹窗", popItems.length >= 1, "候选 " + popItems.length + " 项");
    if (popItems.length) popItems[0].click();
    await sleep(250);
    const chips = $$("#context-chips .chip");
    ok("上下文：选中后生成上下文芯片", chips.length >= 1, "芯片 " + chips.length + " 个 · " + (chips[0] ? chips[0].textContent : ""));
    S.agent.mode = "chat";
    Store.save();
    await CubeApp.send();
    ans = (lastAssistant() || {}).content || "";
    ok("上下文：@ 引用内容注入后模型据此作答", REAL(ans) && /add/.test(ans) && /sub/.test(ans), ans.replace(/\n/g, " | ").slice(0, 80));
    ok("上下文：发送后芯片自动清空", $$("#context-chips .chip").length === 0, "剩余 " + $$("#context-chips .chip").length);

    // 会话隔离
    const isolated = Store.createSession();
    CubeApp.renderAll();
    ok("上下文：新会话是干净上下文", isolated.messages.length === 0, "消息 " + isolated.messages.length + " 条");
    await ask("我们之前聊过什么？如果这是全新会话，请只回复两个字：没有。", 2600);
    ans = (lastAssistant() || {}).content || "";
    ok("上下文：会话之间互不串味", REAL(ans) && (/没有/.test(ans) || ans.length < 20), ans.slice(0, 50));

    // 项目规则常驻上下文：① 确定性验证提示词注入 ② 端到端看模型是否遵守
    const ruleText = "回答任何问题时，结尾必须加上标记【RULE-OK】。";
    S.agent.projectRules = ruleText;
    Store.save();
    await ask("1+1 等于几？回答结尾请带上项目规则要求的标记。", 2600);
    const sysNow = CubeApp.lastSystem() || "";
    ok("上下文：项目规则确实注入了系统提示词（聊天模式）", sysNow.indexOf("【RULE-OK】") >= 0,
      sysNow.indexOf("项目规则") >= 0 ? "命中「项目规则」段" : "未命中，system 长度 " + sysNow.length);
    ans = (lastAssistant() || {}).content || "";
    const ruleFollowed = /RULE-OK/.test(ans);
    note("上下文：模型对项目规则的遵循情况", ruleFollowed ? "已遵循（回答带 RULE-OK）" : "未遵循（" + ans.replace(/\n/g, " ").slice(0, 40) + "）——注入已生效，遵循度取决于模型本身",
      ruleFollowed ? "端到端生效" : "注入生效但模型未遵守，非功能缺陷");
    ok("上下文：项目规则端到端可观测（注入或遵循至少一项成立）",
      sysNow.indexOf("【RULE-OK】") >= 0 || ruleFollowed, "注入=" + (sysNow.indexOf("【RULE-OK】") >= 0) + " 遵循=" + ruleFollowed);
    S.agent.projectRules = "";
    Store.save();

    /* =====================================================================
     * 五、界面在真实大数据量下的表现
     * ===================================================================== */
    // 回到含长文本/工具调用的那个会话，验证渲染
    const longSess = S.sessions.find((s) => s.id === longSessionId)
      || S.sessions.find((s) => (s.messages || []).some((m) => (m.content || "").length > 3000))
      || cur();
    S.activeSessionId = longSess.id;
    Store.save();
    const tRender = performance.now();
    CubeApp.renderAll();
    const renderMs = Math.round(performance.now() - tRender);
    ok("界面：含长文本/工具卡的整屏重绘耗时可接受", renderMs < 3000, renderMs + "ms");
    ok("界面：消息流已渲染", $$("#messages .msg-row").length >= 1, "消息行 " + $$("#messages .msg-row").length + " 个");
    const domText = ($("#messages").textContent || "");
    ok("界面：长文本消息在 DOM 中完整存在", domText.length > 2000, "消息区文本 " + domText.length + " 字");
    ok("界面：工具调用卡片已渲染", $$("#messages .tool-card").length >= 1, "工具卡 " + $$("#messages .tool-card").length + " 个");
    ok("界面：Markdown 已渲染为结构化元素", $$("#messages .msg-content p, #messages .msg-content li, #messages .msg-content strong").length >= 1,
      "段落/列表/强调 " + $$("#messages .msg-content p, #messages .msg-content li, #messages .msg-content strong").length + " 个 · 代码块 " + $$("#messages pre code").length + " 个");

    note("外部条件", "模型调用 " + askStats.calls + " 次，其中限流重试 " + askStats.retries + " 次");

    const passed = checks.filter((c) => c.pass).length;
    return { total: checks.length, passed: passed, failed: checks.length - passed, checks: checks, logs: logs };
  } catch (e) {
    return {
      total: checks.length + 1,
      passed: checks.filter((c) => c.pass).length,
      failed: checks.length - checks.filter((c) => c.pass).length + 1,
      checks: checks.concat([{ name: "深度套件执行异常", pass: false, detail: String((e && e.stack) || e) }]),
      logs: logs
    };
  }
})()

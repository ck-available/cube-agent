/* 演示数据（渲染进程内执行，供 UI 截图使用）——必须是可求值的表达式 */
(function () {
  var S = CubeApp.state();
  S.agent.mode = "agent";
  S.agent.permission = "auto";
  var s = Store.getSession(S.activeSessionId);
  if (!s) s = Store.createSession();
  s.title = "重构用户认证模块";
  s.maskId = "coder";
  var t = Date.now();

  var code1 =
    "export function verifyToken(raw: string) {\n" +
    "  const payload = jwt.verify(raw, SECRET);\n" +
    "  return payload as TokenPayload;\n" +
    "}\n";

  var code2 =
    "PASS  src/auth.test.ts\n" +
    "  verifyToken\n" +
    "    ✓ 返回解析后的 payload\n" +
    "    ✓ 过期 token 抛出错误\n" +
    "\n" +
    "Tests: 2 passed, 2 total\n" +
    "Time: 0.84s\n";

  s.messages = [
    {
      role: "user",
      content: "帮我把 auth.ts 里的 token 校验逻辑抽成独立函数，并补上单元测试。",
      ts: t
    },
    {
      role: "assistant",
      reasoning:
        "先定位内联的校验代码块，确认它依赖的外部变量再定函数签名。抽取后同步更新所有调用点，最后补测试覆盖正常与过期两种情况。",
      content:
        "我先看一眼现有实现，再动手抽取。\n\n计划分三步：\n\n1. 定位 `verifyToken` 相关的内联逻辑\n2. 抽取为独立导出函数并更新调用点\n3. 补充单元测试并运行验证",
      ts: t
    },
    {
      role: "tool",
      name: "read",
      args: { path: "src/auth.ts" },
      content: code1,
      toolCallId: "t1",
      ts: t
    },
    {
      role: "tool",
      name: "edit",
      args: { path: "src/auth.ts", old_str: "jwt.verify(raw, SECRET)", new_str: "verifyToken(raw)" },
      content: "已修改 src/auth.ts（1 处替换）",
      toolCallId: "t2",
      ts: t,
      file: "src/auth.ts",
      diff: [
        { type: " ", text: "export function login(req, res) {" },
        { type: " ", text: "  const raw = req.headers.authorization;" },
        { type: "-", text: "  const payload = jwt.verify(raw, SECRET);" },
        { type: "+", text: "  const payload = verifyToken(raw);" },
        { type: " ", text: "  if (!payload.sub) throw new Error('invalid');" },
        { type: " ", text: "  return res.json({ ok: true });" },
        { type: " ", text: "}" }
      ]
    },
    {
      role: "tool",
      name: "bash",
      args: { command: "npm test -- auth" },
      content: code2,
      toolCallId: "t3",
      ts: t,
      meta: "退出码 0"
    },
    {
      role: "assistant",
      content:
        "抽取完成，测试已跑通。核心改动：\n\n```ts\n// src/auth.ts\nexport function verifyToken(raw: string) {\n  /* 过期 token 直接判定为无效，\n     不再让下游拿到 payload 后自己判断 */\n  if (!raw) throw new Error('missing token');\n  return jwt.verify(raw, SECRET);\n}\n```\n\n| 文件 | 变更 |\n|---|---|\n| `src/auth.ts` | 抽取 `verifyToken` + 更新 3 处调用 |\n| `src/auth.test.ts` | 新增 2 条用例 |\n\n> 校验逻辑现在有独立出口，后续换签名算法只改一处。",
      ts: t
    }
  ];

  s.todo = [
    { id: "1", content: "分析现有校验逻辑与依赖", status: "done" },
    { id: "2", content: "抽取 verifyToken 函数", status: "done" },
    { id: "3", content: "更新所有调用点", status: "running" },
    { id: "4", content: "补充单元测试并运行", status: "pending" }
  ];

  s.trajectory = [
    { type: "complete", label: "抽取完成，测试已跑通", ts: t },
    { type: "tool", label: "bash npm test -- auth", detail: "2 passed", ts: t },
    { type: "permission", label: "等待授权：bash", ts: t },
    { type: "tool", label: "edit src/auth.ts", detail: "1 处替换", ts: t },
    { type: "tool", label: "read src/auth.ts", detail: "返回 6 行", ts: t },
    { type: "assistant", label: "我先看一下现有实现…", ts: t },
    { type: "user", label: "帮我把 auth.ts 里的 token 校验逻辑抽成独立函数", ts: t }
  ];

  s.stats = {
    steps: 4,
    toolCalls: 3,
    durationMs: 12400,
    promptTokens: 8420,
    completionTokens: 1130
  };

  var ctx = document.getElementById("context-chips");
  if (ctx && !ctx.children.length) {
    var chip = document.createElement("div");
    chip.className = "chip";
    chip.appendChild(document.createElement("span")).textContent = "@src/auth.ts";
    var x = document.createElement("span");
    x.className = "x";
    x.title = "移除";
    x.appendChild(document.createElement("span")).textContent = "✕";
    chip.appendChild(x);
    ctx.appendChild(chip);
  }

  Store.save();
  CubeApp.renderAll();
  return true;
})()

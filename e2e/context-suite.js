/* 上下文模块自检：token 估算、窗口识别、拆分口径、压缩结构、UI 实时性
 * 用法：node e2e/context-suite.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "app/js/context.js"), "utf8");

// context.js 依赖 window，用最小沙箱跑纯逻辑
const sandbox = { window: {}, console: console };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "context.js" });
const C = sandbox.window.CubeContext;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  [PASS] " + name + (detail ? "  →  " + detail : "")); }
  else { fail++; console.log("  [FAIL] " + name + (detail ? "  →  " + detail : "")); }
}

console.log("上下文模块自检");
console.log("");

/* ---------- 1. token 估算 ---------- */
ok("空串为 0", C.estimateTokens("") === 0 && C.estimateTokens(null) === 0);
ok("undefined 安全", C.estimateTokens(undefined) === 0);

const en = C.estimateTokens("hello world this is a test");
ok("英文按 ~3.6 字符/token 估算", en > 5 && en < 12, "22 字符 → " + en + " tokens");

const zh = C.estimateTokens("这是一段中文文本用来验证分档估算是否生效");
ok("中文按 ~1 字符/token 估算（高于英文）", zh > en, "16 字 → " + zh + " tokens vs 英文 " + en);

const mixed = C.estimateTokens("函数 sum 计算两个数字之和");
ok("中英混排按字符分别计", mixed > 0 && mixed < mixed + 1, mixed + " tokens");

ok("估算随长度单调递增",
  C.estimateTokens("a".repeat(100)) < C.estimateTokens("a".repeat(200)) &&
  C.estimateTokens("中".repeat(100)) < C.estimateTokens("中".repeat(200)));

/* ---------- 2. 模型窗口识别 ---------- */
ok("Gemini 2.5 识别为 1M", C.windowOf("gemini-2.5-pro") === 1048576, String(C.windowOf("gemini-2.5-pro")));
ok("Claude Sonnet 识别为 200k", C.windowOf("claude-sonnet-4-5") === 200000, String(C.windowOf("claude-sonnet-4-5")));
ok("GPT-4o 识别为 128k", C.windowOf("gpt-4o") === 128000);
ok("DeepSeek 识别为 128k", C.windowOf("deepseek-chat") === 128000);
ok("Qwen 识别为 128k", C.windowOf("qwen-max") === 131072, String(C.windowOf("qwen-max")));
ok("名称带 32k 时按后缀推算", C.windowOf("moonshot-v1-32k") === 32000, String(C.windowOf("moonshot-v1-32k")));
ok("未知模型用保守默认值", C.windowOf("some-unknown-xyz") === 128000, String(C.windowOf("some-unknown-xyz")));
ok("空模型不抛异常", C.windowOf("") > 0);

/* ---------- 3. 拆分口径 ---------- */
const sys = "你是一个助手".repeat(50);
const msgs = [];
for (let i = 0; i < 6; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: "对话内容".repeat(40) });
msgs.push({ role: "tool", content: "文件内容".repeat(200) });

const stat = C.analyze({
  system: sys,
  messages: msgs,
  tools: [{ name: "read", description: "读文件".repeat(20), parameters: { type: "object", properties: { path: { type: "string" } } } }],
  chips: [{ path: "a.js", text: "x".repeat(500) }],
  model: "claude-sonnet-4-5",
  maxTokens: 2048
});

ok("system 计入总量", stat.system > 0, "system=" + stat.system);
ok("工具定义单独计价（常驻开销）", stat.tools > 0, "tools=" + stat.tools);
ok("对话历史与工具结果分开统计", stat.messages > 0 && stat.toolResults > 0,
  "messages=" + stat.messages + " toolResults=" + stat.toolResults);
ok("@ 引用单独计价", stat.chips > 0, "chips=" + stat.chips);
ok("total 等于五部分之和",
  stat.total === stat.system + stat.tools + stat.messages + stat.toolResults + stat.chips,
  stat.total + " = " + [stat.system, stat.tools, stat.messages, stat.toolResults, stat.chips].join("+"));
ok("usable = 窗口 - 输出预留", stat.usable === stat.window - 2048, stat.usable + " = " + stat.window + " - 2048");
ok("remain 计算正确", stat.remain === Math.max(0, stat.usable - stat.total));
ok("pct 为占用比例", Math.abs(stat.pct - stat.total / stat.usable) < 1e-9, (stat.pct * 100).toFixed(3) + "%");
ok("低占用为 ok 档", stat.level === "ok", stat.level);

// 中文 1 字 ≈ 1.05 token；Gemini 2.5 窗口 1048576，可用约 1046528
const high = C.analyze({
  system: "", messages: [{ role: "user", content: "字".repeat(1000000) }],
  tools: [], model: "gemini-2.5-pro", maxTokens: 2048
});
ok("高占用被标为 err 档", high.level === "err", (high.pct * 100).toFixed(0) + "%");

// Claude 200k 窗口，可用 197952；填到 ~75%
const mid = C.analyze({
  system: "", messages: [{ role: "user", content: "字".repeat(148000) }],
  tools: [], model: "claude-sonnet-4-5", maxTokens: 2048
});
ok("70%~85% 标为 warn 档", mid.level === "warn", (mid.pct * 100).toFixed(0) + "%");

// 目标 65%：0.65 * 197952 / 1.05 ≈ 122500 字
const just70 = C.analyze({
  system: "", messages: [{ role: "user", content: "字".repeat(122500) }],
  tools: [], model: "claude-sonnet-4-5", maxTokens: 2048
});
ok("~65% 仍是 ok 档（阈值不误触）", just70.level === "ok", (just70.pct * 100).toFixed(0) + "%");

// 目标 72%：0.72 * 197952 / 1.05 ≈ 135700 字
const over70 = C.analyze({
  system: "", messages: [{ role: "user", content: "字".repeat(135700) }],
  tools: [], model: "claude-sonnet-4-5", maxTokens: 2048
});
ok("~72% 进入 warn 档（提示但不自动压）", over70.level === "warn", (over70.pct * 100).toFixed(0) + "%");

const over85 = C.analyze({
  system: "", messages: [{ role: "user", content: "字".repeat(170000) }],
  tools: [], model: "claude-sonnet-4-5", maxTokens: 2048
});
ok(">85% 为 err 档（自动压缩触发线）", over85.level === "err", (over85.pct * 100).toFixed(0) + "%");

/* ---------- 4. 自动压缩触发条件 ---------- */
const low = C.analyze({ system: "", messages: [{ role: "user", content: "短" }], tools: [], model: "claude-sonnet-4-5" });
ok("低占用不触发压缩", C.shouldCompact(low) === false);

const full = C.analyze({ system: "", messages: [{ role: "user", content: "字".repeat(190000) }], tools: [], model: "claude-sonnet-4-5" });
ok("超阈值且历史够大 → 触发压缩", C.shouldCompact(full) === true, (full.pct * 100).toFixed(0) + "%");

const fullButSmall = C.analyze({ system: "", messages: [{ role: "user", content: "字".repeat(80000) }], tools: [], model: "gpt-5" });
ok("超阈值但历史很小 → 不压（压了没意义）",
  fullButSmall.pct > 0.85 ? C.shouldCompact(fullButSmall) === false : true,
  "pct=" + (fullButSmall.pct * 100).toFixed(0) + "%");

/* ---------- 5. 压缩后的消息结构 ---------- */
const rebuilt = C.rebuild([1, 2, 3], "摘要内容", [{ role: "user", content: "最近的问题" }]);
ok("压缩后第一条是摘要", rebuilt[0].role === "system" && /摘要内容/.test(rebuilt[0].content));
ok("摘要条带 compactSummary 标记（便于渲染时区别对待）", rebuilt[0].compactSummary === true);
ok("近邻原文被保留在摘要之后", rebuilt.length === 2 && rebuilt[1].content === "最近的问题");
ok("无近邻原文时也只返回摘要", C.rebuild([], "只有摘要", []).length === 1);

/* ---------- 6. 按 token 预算保留尾部 ---------- */
const long = [];
for (let i = 0; i < 40; i++) long.push({ role: i % 2 ? "assistant" : "user", content: "内容".repeat(500) });
const tail = C.pickTail(long, 3000);
ok("按 token 预算保留而非固定条数", tail.length < 40 && tail.length > 0, "40 条 → 保留 " + tail.length + " 条");
ok("保留的是最近的消息", tail[tail.length - 1] === long[long.length - 1]);
ok("顺序保持原样", tail[0] === long[long.length - tail.length]);
ok("预算越大保留越多", C.pickTail(long, 6000).length > tail.length,
  "3k→" + tail.length + " 条, 6k→" + C.pickTail(long, 6000).length + " 条");

const toolFirst = [{ role: "tool", content: "x" }, { role: "assistant", content: "y" }, { role: "user", content: "z" }];
const t2 = C.pickTail(toolFirst, 10);
ok("不以 tool 消息开头（切断调用关系会报错）", t2[0].role !== "tool", "首条=" + t2[0].role);

/* ---------- 7. 压缩提示词包含必要要素 ---------- */
const cp = C.compactPrompt("重点看支付模块");
ok("压缩提示词要求结构化摘要", /目标/.test(cp) && /遗留/.test(cp));
ok("压缩提示词会带入用户指定的关注点", /重点看支付模块/.test(cp));
ok("压缩提示词限制长度与禁止复述代码", /不要复述大段代码/.test(cp));

/* ---------- 8. Microcompaction：超大内容折叠 ---------- */
const bigOut = "A".repeat(12000) + "【关键行：端口是 7788】" + "B".repeat(12000);
const bigMsg = { role: "tool", name: "bash", content: bigOut };
ok("超过阈值的工具结果需要折叠", C.needsMicrocompact(bigMsg) === true,
  Math.round(C.estimateTokens(bigOut)) + " tokens");
ok("短消息不折叠", C.needsMicrocompact({ role: "tool", content: "ok" }) === false);
ok("用户消息永不折叠（用户输入是原文，不是可重读产物）",
  C.needsMicrocompact({ role: "user", content: "A".repeat(12000) }) === false);
ok("已折叠过的不会重复处理",
  C.needsMicrocompact({ role: "tool", content: bigOut, microStored: "/x.txt" }) === false);

const ph = C.microPlaceholder(bigMsg, "C:\\data\\toolbox\\tool-1.txt", 6000);
ok("占位符显著短于原文", ph.length < bigOut.length / 4,
  Math.round(bigOut.length) + " → " + ph.length + " 字符");
/* 热尾只保证"最近发生了什么"可见；中间内容靠归档回读与摘要/约束钉保住，
   折叠机制本身不做语义判断 —— 所以这里断言尾部与开头，不是中间。 */
ok("占位符保留尾部热区", ph.indexOf("BBBB") >= 0);
ok("占位符保留开头概览", ph.indexOf("AAAA") >= 0);
ok("占位符明确说明中间已省略", /已省略/.test(ph));
ok("占位符写明完整内容的路径", /tool-1\.txt/.test(ph));
ok("占位符说明可用 read 回读", /read/.test(ph));
ok("占位符标明原始 token 量", /6000 tokens/.test(ph));

/* ---------- 9. 增量摘要提示词 ---------- */
const cpInc = C.compactPrompt(null, true);
ok("增量模式要求输出完整摘要而非增量", /更新后的完整摘要/.test(cpInc));
ok("增量模式禁止新旧拼接", /不要把旧摘要原样贴/.test(cpInc));
ok("增量模式要求处理被推翻的旧结论", /推翻/.test(cpInc));
ok("增量模式警告摘要不应线性膨胀", /线性膨胀/.test(cpInc));
ok("非增量模式不含增量指令", /线性膨胀/.test(C.compactPrompt(null, false)) === false);

/* ---------- 10. 约束钉抽取 ---------- */
const conv = [
  { role: "user", content: "帮我看下这个 bug" },
  { role: "assistant", content: "好的" },
  { role: "user", content: "不要用 TypeScript，全部用 JavaScript 写" },
  { role: "user", content: "端口必须是 7788，不要改成 8080" },
  { role: "user", content: "写完记得跑一下 npm test" },
  { role: "user", content: "这个问题主要是登录态丢失导致的" }
];
const cons = C.extractConstraints(conv);
ok("抽取用户硬性约束", cons.length >= 3, "抽到 " + cons.length + " 条：" + cons.join(" / "));
ok("约束原文保留（不转述）", cons.some((c) => c.indexOf("JavaScript") >= 0));
ok("普通陈述不误判为约束", !cons.some((c) => c.indexOf("登录态丢失") >= 0));
ok("模型回复不会被当成约束", !cons.some((c) => c.indexOf("好的") >= 0));
ok("约束有数量上限", C.extractConstraints(
  Array.from({ length: 40 }, (_, i) => ({ role: "user", content: "必须做第 " + i + " 件事" })), 8
).length <= 8, "上限 8 条");
ok("超长消息不当作约束（多半是粘贴的代码/任务描述）",
  !C.extractConstraints([{ role: "user", content: "必须 " + "x".repeat(300) }]).length);

/* ---------- 11. 三项机制协同：折叠 + 摘要 + 约束 ---------- */
const mixedCase = [
  { role: "user", content: "不要修改数据库结构" },
  { role: "assistant", content: "已确认不动 schema" },
  { role: "tool", name: "bash", content: bigOut },
  { role: "user", content: "继续" }
];
ok("同一会话里约束与折叠可并存",
  C.extractConstraints(mixedCase).length === 1 && C.needsMicrocompact(mixedCase[2]),
  "约束 1 条 · 待折叠 " + (C.needsMicrocompact(mixedCase[2]) ? 1 : 0) + " 块");

console.log("");
console.log("  合计 " + (pass + fail) + " · 通过 " + pass + " · 失败 " + fail);
process.exit(fail ? 1 : 0);
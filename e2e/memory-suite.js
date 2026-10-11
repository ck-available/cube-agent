/* 长期记忆模块的纯逻辑验证：用 vm 造最小 localStorage 沙箱，不依赖浏览器与模型。
 * 关注四件事：存得进、记得准、冲突不覆盖、注入有上限。 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  [PASS] " + name + (detail ? "  →  " + detail : "")); }
  else { fail++; console.log("  [FAIL] " + name + (detail ? "  →  " + detail : "")); }
}

// 最小 localStorage
function mkStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _raw: m
  };
}

function fresh() {
  const ls = mkStore();
  const win = { localStorage: ls, document: {}, console: console };
  win.window = win;
  vm.createContext(win);
  const src = fs.readFileSync(path.join(__dirname, "..", "app", "js", "memory.js"), "utf8");
  vm.runInContext(src, win, { filename: "memory.js" });
  return win.CubeMemory;
}

console.log("长期记忆模块\n");

/* ---------- 1. 基本存取 ---------- */
const M = fresh();
const WS = "F:/proj/demo";
ok("记入项目约定", !!M.remember({ type: "project", text: "这个项目用 pnpm，不要用 npm", workspace: WS }),
  "已记");
ok("记入用户偏好", !!M.remember({ type: "preference", text: "回答要简短，不要长篇大论" }));
ok("记入踩坑经验", !!M.remember({ type: "pitfall", text: "构建脚本在 Windows 上要加 cross-env", workspace: WS }));

let st = M.stats(WS);
ok("统计能区分项目记忆与个人偏好", st.projectCount === 2 && st.profileCount === 1,
  "项目 " + st.projectCount + " 条 · 偏好 " + st.profileCount + " 条");

const got = M.recall({ workspace: WS, query: "pnpm" });
ok("能按关键词召回相关记忆", got.some((m) => m.text.indexOf("pnpm") >= 0),
  "召回 " + got.length + " 条");

/* ---------- 2. 无效输入要被挡住 ---------- */
ok("拒绝未知类型", M.remember({ type: "whatever", text: "随便写点什么" }) === null);
ok("拒绝过短的碎片", M.remember({ type: "project", text: "改", workspace: WS }) === null);
ok("拒绝过长的整段聊天", M.remember({ type: "project", text: "x".repeat(400), workspace: WS }) === null);

/* ---------- 3. 去重与时效 ---------- */
const M2 = fresh();
M2.remember({ type: "constraint", text: "不要修改数据库结构", workspace: "/a" });
M2.remember({ type: "constraint", text: "不要修改数据库结构", workspace: "/a" });
ok("同一条记忆不重复存", M2.stats("/a").projectCount === 1, "存了 " + M2.stats("/a").projectCount + " 条");

/* ---------- 4. 路径归一化 ---------- */
const M3 = fresh();
M3.remember({ type: "project", text: "统一用 4 空格缩进", workspace: "F:/Proj/Demo/" });
const n1 = M3.stats("f:\\proj\\demo").projectCount;
ok("工作区路径写法不同也算同一个项目", n1 === 1,
  "F:/Proj/Demo/ 与 f:\\proj\\demo → " + n1 + " 条");

/* ---------- 5. 冲突消解（不盲目覆盖） ---------- */
const M4 = fresh();
M4.remember({ type: "decision", text: "数据库用 MySQL 8", workspace: "/p" });
M4.supersede("/p", "数据库用 MySQL 8");
M4.remember({ type: "decision", text: "数据库用 PostgreSQL 16", workspace: "/p" });
const rec = M4.recall({ workspace: "/p", query: "数据库" });
ok("被推翻的旧决策仍留档（可追溯）", M4.stats("/p").projectCount === 2);
ok("被推翻的旧决策不再进上下文", !rec.some((m) => m.text.indexOf("MySQL") >= 0),
  "实际召回：" + rec.map((m) => m.text).join(" / "));
ok("新决策正常召回", rec.some((m) => m.text.indexOf("PostgreSQL") >= 0));

/* ---------- 6. 注入预算（记忆不能反过来撑爆上下文） ---------- */
const M5 = fresh();
for (let i = 0; i < 60; i++) {
  M5.remember({ type: "project", text: "第 " + i + " 条项目约定：模块 " + i + " 使用独立目录结构管理", workspace: "/big" });
}
const r5 = M5.recall({ workspace: "/big", query: "模块" });
const cost = r5.reduce((a, m) => a + Math.ceil(m.text.length / 1.6), 0);
ok("注入的记忆不超过预算", cost <= M5.INJECT_BUDGET,
  "注入 " + r5.length + " 条 ≈ " + cost + " tokens（预算 " + M5.INJECT_BUDGET + "）");
ok("预算内仍能召回最重要的若干条", r5.length >= 3 && r5.length <= 12, "召回 " + r5.length + " 条");

/* ---------- 7. 项目隔离 ---------- */
const M6 = fresh();
M6.remember({ type: "project", text: "A 项目的特殊约定：只读不写", workspace: "/projA" });
M6.remember({ type: "project", text: "B 项目的特殊约定：允许直接改", workspace: "/projB" });
const rA = M6.recall({ workspace: "/projA", query: "项目" });
ok("不会把别的项目的记忆串进来", !rA.some((m) => m.text.indexOf("B 项目") >= 0),
  "A 项目召回：" + rA.map((m) => m.text).join(" / "));
const rGlobal = M6.recall({ workspace: "/projC", query: "项目" });
ok("切换到新项目不会带旧项目的知识",
  !rGlobal.some((m) => m.text.indexOf("A 项目") >= 0 || m.text.indexOf("B 项目") >= 0));

/* ---------- 8. 个人偏好跨项目可见 ---------- */
const M7 = fresh();
M7.remember({ type: "preference", text: "代码注释一律用中文" });
const r7a = M7.recall({ workspace: "/x", query: "注释" });
const r7b = M7.recall({ workspace: "/y", query: "注释" });
ok("个人偏好在任何项目都可见", r7a.length === 1 && r7b.length === 1);
ok("偏好不占用项目配额", M7.stats("/x").projectCount === 0 && M7.stats("/x").profileCount === 1);

/* ---------- 9. 删除 ---------- */
const M8 = fresh();
const it = M8.remember({ type: "project", text: "临时约定：这次先不做国际化", workspace: "/d" });
M8.forget(it.id);
ok("能删除指定记忆", M8.stats("/d").projectCount === 0);
M8.remember({ type: "project", text: "另一条约定：日志用 JSON 格式", workspace: "/d" });
M8.clearProject("/d");
ok("能清空整个项目的记忆", M8.stats("/d").projectCount === 0);

/* ---------- 10. 配额溢出时能自愈 ---------- */
const M9 = fresh();
const huge = "测".repeat(50);
for (let i = 0; i < 400; i++) M9.remember({ type: "pitfall", text: huge + i });
ok("记忆条目有上限，不会无限膨胀", M9.stats("/flood").projectCount <= 120,
  "存了 " + M9.stats("/flood").projectCount + " 条（上限 120）");

/* ---------- 11. 存储损坏时能恢复 ---------- */
const broken = mkStore();
broken.setItem("cubeagent.memory.v1", "{不是合法 JSON");
const winBroken = { localStorage: broken, console: console };
winBroken.window = winBroken;
vm.createContext(winBroken);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "app", "js", "memory.js"), "utf8"), winBroken);
ok("存档损坏时不崩溃", !!winBroken.CubeMemory && winBroken.CubeMemory.stats("/x").projectCount === 0);

console.log("");
console.log("  合计 " + (pass + fail) + " · 通过 " + pass + " · 失败 " + fail);
process.exit(fail ? 1 : 0);

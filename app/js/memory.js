/* ============ CubeAgent 长期记忆 ============
 * 解决的核心问题：**会话结束 / 关掉窗口后，一切归零**。
 * 下次开新会话，模型不知道你是谁、这个项目有什么约定、之前踩过什么坑。
 *
 * 设计取舍（对齐 Mem0 / Claude Code 的主流做法，但砍掉向量库的重量）：
 * - 记忆分两类物理隔离：**用户画像**（跨项目的个人偏好）与 **项目记忆**（随工作区的项目知识）
 * - 条目结构化：{ id, type, text, source, ts, status }，status 用于冲突消解（不盲目覆盖）
 * - 检索不用向量库：**关键词命中 + 时效打分**，本地项目够用且零依赖、零网络
 * - 注入有上限：宁缺毋滥，超过预算就不注入 —— 记忆本身也会造成 context rot
 */
(function () {
  "use strict";

  var KEY = "cubeagent.memory.v1";

  /* 记忆类型及其注入权重：偏好类始终要带，项目约定次之 */
  var TYPES = {
    preference: { label: "用户偏好", hint: "用户明确表达过的习惯、口吻、风格要求", sticky: true },
    constraint: { label: "硬性要求", hint: "必须遵守的规则，违反会返工", sticky: true },
    project: { label: "项目约定", hint: "这个项目的技术栈、规范、目录约定", sticky: false },
    decision: { label: "关键决策", hint: "做过的重要技术选择及原因", sticky: false },
    pitfall: { label: "踩过的坑", hint: "曾经的错误与解法，别再犯", sticky: false }
  };

  /* 单次注入的记忆预算（tokens）。超过就不注入 —— 记忆也是上下文污染源。 */
  var INJECT_BUDGET = 1200;
  var MAX_PER_PROJECT = 120;

  function empty() {
    return { profile: {}, projects: {}, version: 1 };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return empty();
      var d = JSON.parse(raw);
      if (!d || typeof d !== "object") return empty();
      if (!d.profile || typeof d.profile !== "object") d.profile = {};
      if (!d.projects || typeof d.projects !== "object") d.projects = {};
      return d;
    } catch (e) {
      return empty();
    }
  }

  function save(d) {
    try {
      localStorage.setItem(KEY, JSON.stringify(d));
      return true;
    } catch (e) {
      // 配额满是最常见失败原因：丢弃最旧的条目再试一次
      try {
        var all = Object.keys(d.projects).reduce(function (acc, k) {
          return acc.concat(d.projects[k].map(function (m) { return m; }));
        }, []).sort(function (a, b) { return a.ts - b.ts; });
        while (all.length > 20) d.projects[Object.keys(d.projects).find(function (k) {
          return d.projects[k].indexOf(all.shift()) >= 0;
        })].pop();
        localStorage.setItem(KEY, JSON.stringify(d));
        return true;
      } catch (e2) { return false; }
    }
  }

  function projectKey(workspace) {
    if (!workspace) return "_global";
    // 统一大小写与分隔符，避免同一项目因写法不同产生两份记忆
    return String(workspace).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  function nid() {
    return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /**
   * 记一条。
   * @param {object} m { type, text, workspace, source }
   */
  function remember(m) {
    if (!m || !m.text || !TYPES[m.type]) return null;
    var text = String(m.text).trim().replace(/\s+/g, " ");
    if (text.length < 4 || text.length > 300) return null;   // 太短没信息量，太长是整段聊天

    var d = load();
    var k = projectKey(m.workspace);

    // 项目无关的类型（个人偏好）写进 profile，不随工作区切换
    if (TYPES[m.type].sticky && !m.workspace) {
      d.profile[m.type] = d.profile[m.type] || {};
      d.profile[m.type][text] = { text: text, ts: Date.now() };
      save(d);
      return d.profile[m.type][text];
    }

    d.projects[k] = d.projects[k] || [];
    var list = d.projects[k];

    // 去重：同一条不重复记
    for (var i = 0; i < list.length; i++) {
      if (list[i].text === text) {
        list[i].ts = Date.now();          // 重复出现说明还重要，刷新时效
        list[i].hits = (list[i].hits || 0) + 1;
        save(d);
        return list[i];
      }
    }

    var item = {
      id: nid(),
      type: m.type,
      text: text,
      source: String(m.source || "").slice(0, 60),
      ts: Date.now(),
      status: "active",
      hits: 0
    };
    list.unshift(item);
    if (list.length > MAX_PER_PROJECT) list.length = MAX_PER_PROJECT;
    save(d);
    return item;
  }

  /** 冲突消解：新条目与旧的同主题但表述不同时，把旧条标为 superseded，而不是删掉 */
  function supersede(workspace, oldText) {
    var d = load();
    var list = d.projects[projectKey(workspace)] || [];
    list.forEach(function (it) { if (it.text === oldText) it.status = "superseded"; });
    save(d);
  }

  /**
   * 按当前上下文挑相关记忆。
   * 关键词命中 + 类型权重 + 时效衰减，无需向量库。
   */
  function recall(opts) {
    opts = opts || {};
    var d = load();
    var k = projectKey(opts.workspace);
    var query = String(opts.query || "").toLowerCase();

    var pool = [];
    // 个人偏好永远参与
    Object.keys(d.profile).forEach(function (t) {
      Object.keys(d.profile[t]).forEach(function (txt) {
        pool.push({ id: d.profile[t][txt].ts, type: t, text: d.profile[t][txt].text, ts: d.profile[t][txt].ts, hits: 0, status: "active" });
      });
    });
    // 当前项目 + 全局项目
    (d.projects[k] || []).forEach(function (it) { pool.push(it); });
    (d.projects._global || []).forEach(function (it) { pool.push(it); });

    var now = Date.now();
    var scored = pool.map(function (it) {
      var score = 0;
      if (TYPES[it.type] && TYPES[it.type].sticky) score += 6;
      // 关键词命中：中文按 2 字片段，英文按词
      if (query) {
        if (it.text.toLowerCase().indexOf(query) >= 0) score += 10;
        var toks = query.match(/[\u4e00-\u9fa5]{2,}|[a-z0-9_]{3,}/g) || [];
        toks.forEach(function (t) { if (it.text.toLowerCase().indexOf(t) >= 0) score += 3; });
      }
      // 时效：30 天内线性衰减，太久远的不重要
      var ageDays = (now - (it.ts || now)) / 86400000;
      score += Math.max(0, 4 - ageDays / 8);
      score += Math.min(3, (it.hits || 0));      // 被反复命中过的更重要
      if (it.status === "superseded") score -= 100;   // 已被推翻的几乎不进上下文
      return { it: it, score: score };
    }).filter(function (x) { return x.score > 0; })
      .sort(function (a, b) { return b.score - a.score; });

    var out = [];
    var used = 0;
    for (var i = 0; i < scored.length && out.length < 12; i++) {
      var t = scored[i].it.text;
      var cost = Math.ceil(t.length / 1.6);      // 中文约 1.6 字符/token
      if (used + cost > INJECT_BUDGET) break;
      used += cost;
      out.push(scored[i].it);
    }
    return out;
  }

  function forget(id) {
    var d = load();
    Object.keys(d.projects).forEach(function (k) {
      d.projects[k] = d.projects[k].filter(function (it) { return it.id !== id; });
      if (!d.projects[k].length) delete d.projects[k];
    });
    Object.keys(d.profile).forEach(function (t) {
      Object.keys(d.profile[t]).forEach(function (txt) {
        if (d.profile[t][txt].ts === id) delete d.profile[t][txt];
      });
    });
    save(d);
    return true;
  }

  function clearProject(workspace) {
    var d = load();
    delete d.projects[projectKey(workspace)];
    save(d);
    return true;
  }

  function stats(workspace) {
    var d = load();
    var list = d.projects[projectKey(workspace)] || [];
    var byType = {};
    Object.keys(TYPES).forEach(function (t) { byType[t] = 0; });
    list.forEach(function (it) { if (byType[it.type] != null) byType[it.type] += 1; });
    return {
      projectCount: list.length,
      profileCount: Object.keys(d.profile).reduce(function (a, t) {
        return a + Object.keys(d.profile[t]).length;
      }, 0),
      byType: byType,
      projects: Object.keys(d.projects).length
    };
  }

  window.CubeMemory = {
    TYPES: TYPES,
    INJECT_BUDGET: INJECT_BUDGET,
    remember: remember,
    recall: recall,
    supersede: supersede,
    forget: forget,
    clearProject: clearProject,
    stats: stats,
    load: load
  };
})();

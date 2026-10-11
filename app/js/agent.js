/* ============ CubeAgent Agent Loop ============
 * 借鉴 OpenAI Codex / DeepSeek Harness / Claude Code 的循环结构：
 *   模型输出 → 若有工具调用 → 权限检查 → 执行 → 结果回灌 → 再次请求（直到完成或达上限）
 * 所有工具执行都被限制在工作区内，写/执行按模式决定是否征求确认。
 */
(function () {
  "use strict";

  const MAX_STEPS = 40;          // 单次任务最大 round-trip
  const MAX_TOOL_CHARS = 9000;   // 单条工具结果进入上下文的上限

  function buildSystem(opts) {
    const lines = [];
    lines.push("你是 CubeAgent —— 一个可以直接操作本地工作区的 AI Agent（类似 Codex / Claude Code 的桌面客户端）。");
    lines.push("");
    lines.push("# 工作环境");
    lines.push("- 操作系统：" + (opts.platform || "unknown"));
    lines.push("- 工作区根目录：" + (opts.workspace || "（未选择）"));
    lines.push("- 当前时间：" + new Date().toLocaleString());
    lines.push("");
    lines.push("# 工作方式（必须遵守）");
    lines.push("1. 先搞清楚现状：用 list_dir / glob / grep / read 了解项目结构，不要凭空猜测文件内容。");
    lines.push("2. 动手前先计划：任务超过 3 步就用 todo_write 建立清单，边做边更新状态。");
    lines.push("3. 修改优先用 edit（精确替换），只有新建文件或大范围重写时才用 write。");
    lines.push("4. 改完就验证：能跑测试就跑测试（bash），把真实输出贴给用户，不许编造结果。");
    lines.push("5. 全部完成后必须调用 task_complete 给出总结：改了哪些文件、验证结果、还有什么风险。");
    lines.push("6. 不确定就问用户，不要猜；不要执行会破坏系统或工作区之外的命令。");
    lines.push("7. 路径一律使用相对工作区的相对路径。");
    lines.push("8. 【重要】read 返回的内容每行带有「行号+制表符」前缀，那只是给你定位用的，" +
      "写文件时绝对不能把行号写进内容，edit 的 old_str / new_str 也不含行号——否则文件会被写坏。");
    if (opts.projectRules) {
      lines.push("");
      lines.push("# 项目规则（来自工作区的 AGENTS.md / 用户自定义）");
      lines.push(opts.projectRules);
    }
    /* 约束钉（Constraint Pinning，借鉴 Codex CLI）：
       用户在对话中明确说过的硬性要求——"不要用 X"、"必须用 Y"、"端口是 Z"——
       极易在压缩 / 长历史里丢失，导致模型"忘记"并违背。
       Codex 的实测是重注入后违规率从 30~59% 降到 0%。
       这里把原文（不转述）重放一遍，成本只有几十 token。 */
    /* 注入必须有硬上限：记忆条目多了会挤占真正的对话上下文，
       反而让模型"记得一堆没用的、忘了正在做的事"。这里按条数 + 字符双重封顶。 */
    const CONSTRAINT_MAX = 20;
    const MEMORY_MAX = 24;
    const MEMORY_CHAR_MAX = 2400;
    if (opts.constraints && opts.constraints.length) {
      const cs = opts.constraints.slice(0, CONSTRAINT_MAX);
      lines.push("");
      lines.push("# 用户明确指定的要求（必须严格遵守，不得忽略或" +
        "用自己的偏好替代）");
      cs.forEach((c, i) => lines.push((i + 1) + ". " + c));
      if (opts.constraints.length > cs.length) {
        lines.push("（另有 " + (opts.constraints.length - cs.length) + " 条较早的要求未列出，如有冲突以本节为准）");
      }
    }
    /* 跨会话长期记忆：让"关掉窗口重开"不再是归零。
       只注入与当前任务相关的少量条目 —— 记忆本身也是上下文，过量同样会导致召回变差。 */
    if (opts.memories && opts.memories.length) {
      const picked = [];
      let chars = 0;
      for (const m of opts.memories) {
        if (picked.length >= MEMORY_MAX) break;
        const t = String((m && m.text) || "");
        if (!t) continue;
        if (chars + t.length > MEMORY_CHAR_MAX && picked.length) break;
        picked.push(m);
        chars += t.length;
      }
      if (picked.length) {
        lines.push("");
        lines.push("# 长期记忆（来自你与用户此前的会话，与当前任务相关）");
        picked.forEach((m) => {
          const tag = (opts.memoryLabels && opts.memoryLabels[m.type]) || "记忆";
          lines.push("- [" + tag + "] " + m.text);
        });
        if (opts.memoriesSuperseded && opts.memoriesSuperseded.length) {
          lines.push("- 注意：以下旧结论已被推翻，不要再按它们行事：" +
            opts.memoriesSuperseded.join("；"));
        }
      }
    }
    return lines.join("\n");
  }

  function truncate(text) {
    const s = String(text == null ? "" : text);
    if (s.length <= MAX_TOOL_CHARS) return s;
    return s.slice(0, MAX_TOOL_CHARS) + "\n…（工具输出过长，已截断 " + (s.length - MAX_TOOL_CHARS) + " 字符）";
  }

  /**
   * run(opts)
   *  opts: {
   *    provider, model, params, history, system, tools, signal,
   *    mode: 'suggest'|'auto'|'full',
   *    sessionAllow: Set (运行时记忆"本次会话总是允许"),
   *    onEvent(type, payload),
   *    requestPermission({tool,args,summary,risk}) => 'once'|'always'|'deny',
   *    checkpoints: {} // 写文件前快照，用于回滚
   *  }
   * 返回 { finished:boolean, steps:number, toolCalls:number }
   */
  async function run(opts) {
    const history = opts.history;   // 与 UI 共享同一个数组，便于实时渲染
    const tools = opts.tools || [];
    let steps = 0, calls = 0, finished = false;
    const recent = [];   // 重复调用检测

    while (steps < MAX_STEPS) {
      if (opts.signal && opts.signal.aborted) break;
      steps++;
      opts.onEvent("turn_start", { step: steps });

      const assistant = { role: "assistant", content: "", reasoning: "" };
      let renderPending = false;
      const flush = () => {
        if (renderPending) return;
        renderPending = true;
        requestAnimationFrame(() => {
          renderPending = false;
          opts.onEvent("assistant_delta_view", {
            content: assistant.content,
            reasoning: assistant.reasoning
          });
        });
      };

      let result;
      try {
        result = await Providers.streamChat(opts.provider, {
          model: opts.model,
          messages: history,
          system: opts.system,
          params: opts.params,
          tools: tools.length ? tools : null,
          signal: opts.signal,
          onDelta: (text, kind) => {
            if (kind === "reasoning") assistant.reasoning += text;
            else assistant.content += text;
            opts.onEvent("assistant_delta", { text: text, kind: kind });
            flush();
          }
        });
      } catch (err) {
        if (err && err.name === "AbortError") {
          opts.onEvent("notice", { text: "已停止" });
          break;
        }
        opts.onEvent("error", { message: err.message || String(err) });
        break;
      }

      // 只要有工具调用也必须落这条 assistant，否则 tool 消息会失去父调用导致 API 报错
      if (assistant.content || assistant.reasoning || toolCalls.length) {
        assistant.toolCalls = (result && result.toolCalls) || [];
        history.push(assistant);
        opts.onEvent("assistant_end", {
          content: assistant.content,
          reasoning: assistant.reasoning,
          toolCalls: assistant.toolCalls,
          usage: result && result.usage
        });
      }

      const toolCalls = (result && result.toolCalls) || [];
      if (!toolCalls.length) { finished = true; break; }

      for (const tc of toolCalls) {
        if (opts.signal && opts.signal.aborted) break;
        calls++;

        // 重复调用保护
        const sig = tc.name + "|" + JSON.stringify(tc.args);
        const sameCount = recent.filter((x) => x === sig).length;
        recent.push(sig);
        if (sameCount >= 3) {
          opts.onEvent("notice", { text: "检测到工具重复调用，已中断以避免空转：" + tc.name });
          history.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: "（系统）该调用重复多次，请换个思路或结束任务。" });
          finished = true;
          break;
        }

        const risk = CubeTools.riskOf(tc.name);
        const key = tc.name + ":" + risk;
        let decision = CubeTools.allowedByMode(opts.mode, risk) ? "once" : null;
        if (!decision && opts.sessionAllow && opts.sessionAllow.has(key)) decision = "once";
        if (!decision) {
          opts.onEvent("permission_wait", { tool: tc.name, args: tc.args, risk: risk });
          decision = await opts.requestPermission({
            tool: tc.name,
            args: tc.args,
            summary: CubeTools.summarize(tc.name, tc.args),
            risk: risk
          });
        }
        if (decision === "always" && opts.sessionAllow) opts.sessionAllow.add(key);
        if (decision === "deny") {
          opts.onEvent("permission_denied", { tool: tc.name, args: tc.args });
          history.push({
            role: "tool", toolCallId: tc.id, name: tc.name,
            content: "用户拒绝执行该操作。请改用只读方式继续分析，或向用户说明你需要什么授权。"
          });
          continue;
        }

        opts.onEvent("tool_start", { id: tc.id, name: tc.name, args: tc.args, risk: risk });
        let res;
        try {
          res = await CubeTools.execute(tc.name, tc.args, {
            onCheckpoint: (file, prev) => {
              if (opts.checkpoints && !(file in opts.checkpoints)) opts.checkpoints[file] = prev;
            }
          });
        } catch (err) {
          res = { output: "工具执行失败：" + (err.message || String(err)) };
        }
        const output = truncate(res.output);
        opts.onEvent("tool_result", {
          id: tc.id, name: tc.name, args: tc.args,
          output: output, meta: res.meta, diff: res.diff, file: res.file,
          items: res.items, ui: res.ui, refused: res.refused
        });
        history.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: output });

        if (res.complete) {
          finished = true;
          opts.onEvent("complete", { summary: output });
          break;
        }
      }
      if (finished) break;
    }

    if (!finished && steps >= MAX_STEPS) {
      opts.onEvent("notice", { text: "已达到单任务最大步数（" + MAX_STEPS + " 步），如需继续请追加说明。" });
    }
    opts.onEvent("run_end", { steps: steps, toolCalls: calls, finished: finished, history: history });
    return { finished: finished, steps: steps, toolCalls: calls };
  }

  window.CubeAgent = { run: run, buildSystem: buildSystem, MAX_STEPS: MAX_STEPS };
})();

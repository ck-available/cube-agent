/* ============ CubeAgent 服务商适配器（统一流式 + 工具调用） ============
 * 统一入口 streamChat(provider, payload)
 * payload: { model, messages, params, tools, system, signal, onDelta, onToolCall, onRaw }
 * 内部消息格式：{ role:'user'|'assistant'|'tool', content, toolCalls?, toolCallId?, name? }
 */
(function () {
  "use strict";

  function joinUrl(base, p) {
    return base.replace(/\/+$/, "") + p;
  }

  async function assertOk(resp) {
    if (!resp.ok) {
      let text = "";
      try { text = await resp.text(); } catch (e) { /* ignore */ }
      let msg = "HTTP " + resp.status;
      try {
        const j = JSON.parse(text);
        msg += "：" + ((j.error && (j.error.message || j.error.type)) || j.message || text.slice(0, 300));
      } catch (e) {
        msg += text ? "：" + text.slice(0, 300) : "";
      }
      throw new Error(msg);
    }
  }

  async function readLines(resp, onLine) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        onLine(line.replace(/\r$/, ""));
      }
    }
    if (buffer.trim()) onLine(buffer);
  }

  function parseArgs(raw) {
    if (!raw) return {};
    try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return { _raw: raw }; }
  }

  /* ================= 工具 schema 适配 ================= */
  function openaiTools(tools) {
    return tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
  }

  function anthropicTools(tools) {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }));
  }

  function upper(s) {
    if (typeof s !== "string") return s;
    return s.toUpperCase();
  }

  function geminiSchema(schema) {
    if (!schema || typeof schema !== "object") return schema;
    const out = {};
    Object.keys(schema).forEach((k) => {
      if (k === "$schema" || k === "additionalProperties" || k === "additionalProperties") return;
      if (k === "type") {
        const t = schema[k];
        if (Array.isArray(t)) out.type = upper(t[0]);
        else out.type = upper(t);
        return;
      }
      if (k === "properties" && schema[k] && typeof schema[k] === "object") {
        const props = {};
        Object.keys(schema[k]).forEach((pk) => { props[pk] = geminiSchema(schema[k][pk]); });
        out.properties = props;
        return;
      }
      if (k === "items") { out.items = geminiSchema(schema[k]); return; }
      if (k === "enum" || k === "description" || k === "required" || k === "nullable") { out[k] = schema[k]; return; }
      out[k] = schema[k];
    });
    return out;
  }

  function geminiTools(tools) {
    return [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: geminiSchema(t.parameters)
      }))
    }];
  }

  /* ================= 消息转换 ================= */
  function toOpenAIMessages(messages) {
    return messages.map((m) => {
      if (m.role === "assistant") {
        const out = { role: "assistant", content: m.content || "" };
        if (m.toolCalls && m.toolCalls.length) {
          out.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) }
          }));
        }
        return out;
      }
      if (m.role === "tool") {
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      }
      return { role: "user", content: m.content };
    });
  }

  function toAnthropicMessages(messages) {
    const out = [];
    // Claude 要求：user / assistant 严格交替，且 tool_result 必须放在同一个 user 轮次里
    const pushUserText = (text) => {
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) last.content.push({ type: "text", text: text });
      else if (last && last.role === "user" && typeof last.content === "string") last.content = [{ type: "text", text: last.content }, { type: "text", text: text }];
      else out.push({ role: "user", content: text });
    };
    const pushUserBlock = (block) => {
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else if (last && last.role === "user" && typeof last.content === "string") last.content = [{ type: "text", text: last.content }, block];
      else out.push({ role: "user", content: [block] });
    };

    messages.forEach((m) => {
      if (m.role === "user") {
        pushUserText(m.content);
      } else if (m.role === "assistant") {
        const blocks = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        (m.toolCalls || []).forEach((tc) => {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args || {} });
        });
        if (!blocks.length) blocks.push({ type: "text", text: "" });
        out.push({ role: "assistant", content: blocks });
      } else if (m.role === "tool") {
        pushUserBlock({ type: "tool_result", tool_use_id: m.toolCallId, content: m.content || "" });
      }
    });

    // Claude 首条必须是 user
    while (out.length && out[0].role !== "user") out.shift();
    return out;
  }

  function toGeminiMessages(messages) {
    return messages.map((m) => {
      if (m.role === "assistant") {
        const parts = [];
        if (m.content) parts.push({ text: m.content });
        (m.toolCalls || []).forEach((tc) => parts.push({ functionCall: { name: tc.name, args: tc.args || {} } }));
        if (!parts.length) parts.push({ text: "" });
        return { role: "model", parts };
      }
      if (m.role === "tool") {
        return {
          role: "function",
          parts: [{
            functionResponse: { name: m.name || m.toolCallId, response: { output: m.content || "" } }
          }]
        };
      }
      return { role: "user", parts: [{ text: m.content }] };
    });
  }

  function toOllamaMessages(messages) {
    return messages.map((m) => {
      if (m.role === "assistant") {
        const out = { role: "assistant", content: m.content || "" };
        if (m.toolCalls && m.toolCalls.length) {
          out.tool_calls = m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.args || {} } }));
        }
        return out;
      }
      if (m.role === "tool") return { role: "tool", content: m.content };
      return { role: "user", content: m.content };
    });
  }

  /* ================= OpenAI 兼容 ================= */
  async function streamOpenAI(provider, p) {
    const body = {
      model: p.model,
      messages: toOpenAIMessages(p.messages),
      temperature: p.params.temperature,
      max_tokens: p.params.maxTokens,
      stream: true,
      stream_options: { include_usage: true }
    };
    if (p.tools && p.tools.length) {
      body.tools = openaiTools(p.tools);
      body.tool_choice = "auto";
    }
    const resp = await fetch(joinUrl(provider.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + provider.apiKey },
      body: JSON.stringify(body),
      signal: p.signal
    });
    await assertOk(resp);

    let usage = null;
    const calls = new Map();
    await readLines(resp, (line) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      let j;
      try { j = JSON.parse(data); } catch (e) { return; }
      if (j.usage) usage = j.usage;
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      if (!delta) return;
      if (delta.reasoning_content) p.onDelta(delta.reasoning_content, "reasoning");
      if (delta.content) p.onDelta(delta.content, "content");
      (delta.tool_calls || []).forEach((tc) => {
        const idx = tc.index != null ? tc.index : 0;
        const cur = calls.get(idx) || { id: tc.id || "", name: "", argsRaw: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function && tc.function.name) cur.name += tc.function.name;
        if (tc.function && tc.function.arguments) cur.argsRaw += tc.function.arguments;
        calls.set(idx, cur);
      });
    });
    const toolCalls = Array.from(calls.keys()).sort((a, b) => a - b).map((k) => {
      const c = calls.get(k);
      return { id: c.id || ("call_" + k), name: c.name, args: parseArgs(c.argsRaw) };
    });
    return { usage, toolCalls };
  }

  /* ================= Anthropic ================= */
  async function streamAnthropic(provider, p) {
    let system = p.system || "";
    p.messages.forEach((m) => { if (m.role === "system") system += (system ? "\n" : "") + m.content; });
    const body = {
      model: p.model,
      system: system || undefined,
      messages: toAnthropicMessages(p.messages.filter((m) => m.role !== "system")),
      max_tokens: p.params.maxTokens,
      temperature: p.params.temperature,
      stream: true
    };
    if (p.tools && p.tools.length) body.tools = anthropicTools(p.tools);
    const resp = await fetch(joinUrl(provider.baseUrl, "/v1/messages"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(body),
      signal: p.signal
    });
    await assertOk(resp);

    let usage = null;
    const calls = new Map();
    await readLines(resp, (line) => {
      if (!line.startsWith("data:")) return;
      let j;
      try { j = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
      if (j.type === "content_block_start" && j.content_block && j.content_block.type === "tool_use") {
        calls.set(j.index, { id: j.content_block.id, name: j.content_block.name, argsRaw: "" });
      } else if (j.type === "content_block_delta" && j.delta) {
        const keyOwner = calls.get(j.index);
        if (j.delta.type === "input_json_delta" && keyOwner) keyOwner.argsRaw += j.delta.partial_json || "";
        else if (j.delta.type === "text_delta") p.onDelta(j.delta.text, "content");
        else if (j.delta.type === "thinking_delta") p.onDelta(j.delta.thinking, "reasoning");
      } else if (j.type === "message_delta" && j.usage) {
        usage = j.usage;
      }
    });
    const toolCalls = Array.from(calls.keys()).sort((a, b) => a - b).map((k) => {
      const c = calls.get(k);
      return { id: c.id, name: c.name, args: parseArgs(c.argsRaw) };
    });
    return { usage, toolCalls };
  }

  /* ================= Gemini ================= */
  async function streamGemini(provider, p) {
    const systemParts = [];
    if (p.system) systemParts.push({ text: p.system });
    p.messages.forEach((m) => { if (m.role === "system") systemParts.push({ text: m.content }); });
    const url = joinUrl(provider.baseUrl, "/v1beta/models/" + encodeURIComponent(p.model) +
      ":streamGenerateContent?alt=sse&key=" + encodeURIComponent(provider.apiKey));
    const body = {
      system_instruction: systemParts.length ? { parts: systemParts } : undefined,
      contents: toGeminiMessages(p.messages.filter((m) => m.role !== "system")),
      generationConfig: { temperature: p.params.temperature, maxOutputTokens: p.params.maxTokens }
    };
    if (p.tools && p.tools.length) body.tools = geminiTools(p.tools);
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: p.signal
    });
    await assertOk(resp);

    let usage = null;
    const calls = [];
    await readLines(resp, (line) => {
      if (!line.startsWith("data:")) return;
      let j;
      try { j = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
      if (j.usageMetadata) usage = j.usageMetadata;
      const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
      if (!parts) return;
      parts.forEach((pt) => {
        if (pt.thought) p.onDelta(pt.text || "", "reasoning");
        else if (pt.text) p.onDelta(pt.text, "content");
        else if (pt.functionCall) {
          const key = pt.functionCall.name + "|" + JSON.stringify(pt.functionCall.args || {});
          if (!calls.some((c) => c.key === key)) {
            calls.push({
              key,
              id: "gemini_" + calls.length,
              name: pt.functionCall.name,
              args: pt.functionCall.args || {}
            });
          }
        }
      });
    });
    return { usage, toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })) };
  }

  /* ================= Ollama ================= */
  async function streamOllama(provider, p) {
    const body = {
      model: p.model,
      messages: toOllamaMessages(p.messages),
      stream: true,
      options: { temperature: p.params.temperature, num_predict: p.params.maxTokens }
    };
    if (p.tools && p.tools.length) {
      body.tools = openaiTools(p.tools).map((t) => t.function);
    }
    const resp = await fetch(joinUrl(provider.baseUrl, "/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: p.signal
    });
    await assertOk(resp);

    const calls = [];
    await readLines(resp, (line) => {
      if (!line.trim()) return;
      let j;
      try { j = JSON.parse(line); } catch (e) { return; }
      if (j.message && j.message.content) p.onDelta(j.message.content, "content");
      if (j.message && Array.isArray(j.message.tool_calls)) {
        j.message.tool_calls.forEach((tc) => {
          calls.push({
            id: "ollama_" + calls.length,
            name: tc.function && tc.function.name,
            args: (tc.function && (tc.function.arguments || tc.function.arguments_json)) || {}
          });
        });
      }
    });
    return { usage: null, toolCalls: calls };
  }

  async function fetchModels(provider) {
    let resp, j;
    switch (provider.type) {
      case "openai":
        resp = await fetch(joinUrl(provider.baseUrl, "/models"), { headers: { "Authorization": "Bearer " + provider.apiKey } });
        await assertOk(resp);
        j = await resp.json();
        return (j.data || []).map((m) => m.id).sort();
      case "anthropic":
        resp = await fetch(joinUrl(provider.baseUrl, "/v1/models"), {
          headers: {
            "x-api-key": provider.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true"
          }
        });
        await assertOk(resp);
        j = await resp.json();
        return (j.data || []).map((m) => m.id).sort();
      case "gemini":
        resp = await fetch(joinUrl(provider.baseUrl, "/v1beta/models?key=" + encodeURIComponent(provider.apiKey)));
        await assertOk(resp);
        j = await resp.json();
        return (j.models || []).map((m) => (m.name || "").replace(/^models\//, "")).filter((n) => n.indexOf("gemini") >= 0).sort();
      case "ollama":
        resp = await fetch(joinUrl(provider.baseUrl, "/api/tags"));
        await assertOk(resp);
        j = await resp.json();
        return (j.models || []).map((m) => m.name).sort();
      default:
        throw new Error("未知服务商类型");
    }
  }

  async function streamChat(provider, payload) {
    switch (provider.type) {
      case "openai": return streamOpenAI(provider, payload);
      case "anthropic": return streamAnthropic(provider, payload);
      case "gemini": return streamGemini(provider, payload);
      case "ollama": return streamOllama(provider, payload);
      default: throw new Error("不支持的服务商类型：" + provider.type);
    }
  }

  window.Providers = { streamChat, fetchModels };
})();

/* ============ CubeAgent 本地存储 ============ */
(function () {
  "use strict";

  var STORAGE_KEY = "cubeagent.v1";

  var DEFAULT_PROVIDERS = [
    {
      id: "agnes", name: "Agnes（默认）", type: "openai", builtin: true,
      baseUrl: "https://apihub.agnes-ai.com/v1",
      apiKey: (typeof window !== "undefined" && window.__CUBE_DEFAULT_KEY__) || "",
      models: ["agnes-2.5-flash", "agnes-2.5-pro"],
      keyHint: "apihub.agnes-ai.com 申请；OpenAI 兼容接口"
    },
    {
      id: "deepseek", name: "DeepSeek", type: "openai", builtin: true,
      baseUrl: "https://api.deepseek.com/v1", apiKey: "",
      models: ["deepseek-chat", "deepseek-reasoner"],
      keyHint: "platform.deepseek.com 申请"
    },
    {
      id: "kimi", name: "Kimi（月之暗面）", type: "openai", builtin: true,
      baseUrl: "https://api.moonshot.cn/v1", apiKey: "",
      models: ["kimi-k2-0905-preview", "moonshot-v1-8k", "moonshot-v1-32k"],
      keyHint: "platform.moonshot.cn 申请"
    },
    {
      id: "qwen", name: "通义千问", type: "openai", builtin: true,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "",
      models: ["qwen-plus", "qwen-max", "qwen-turbo"],
      keyHint: "阿里云百炼平台申请"
    },
    {
      id: "zhipu", name: "智谱 GLM", type: "openai", builtin: true,
      baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "",
      models: ["glm-4-flash", "glm-4-air", "glm-4-plus"],
      keyHint: "bigmodel.cn 申请，glm-4-flash 可免费使用"
    },
    {
      id: "openai", name: "OpenAI", type: "openai", builtin: true,
      baseUrl: "https://api.openai.com/v1", apiKey: "",
      models: ["gpt-4o-mini", "gpt-4o"],
      keyHint: "platform.openai.com 申请"
    },
    {
      id: "openrouter", name: "OpenRouter", type: "openai", builtin: true,
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "",
      models: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash"],
      keyHint: "openrouter.ai 申请，一个 Key 用遍全网模型"
    },
    {
      id: "anthropic", name: "Anthropic Claude", type: "anthropic", builtin: true,
      baseUrl: "https://api.anthropic.com", apiKey: "",
      models: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
      keyHint: "console.anthropic.com 申请"
    },
    {
      id: "gemini", name: "Google Gemini", type: "gemini", builtin: true,
      baseUrl: "https://generativelanguage.googleapis.com", apiKey: "",
      models: ["gemini-2.5-flash", "gemini-2.5-pro"],
      keyHint: "aistudio.google.com 免费申请"
    },
    {
      id: "ollama", name: "Ollama（本地）", type: "ollama", builtin: true,
      baseUrl: "http://localhost:11434", apiKey: "",
      models: ["qwen3:8b", "llama3.1:8b", "deepseek-r1:8b"],
      keyHint: "本地运行，无需 Key；需设置 OLLAMA_ORIGINS=* 环境变量"
    }
  ];

  var DEFAULT_MASKS = [
    { id: "general", emoji: "🤖", name: "通用助手", builtin: true, desc: "乐于助人的 AI 助手",
      prompt: "你是 CubeAgent，一个乐于助人的 AI 助手。回答准确、简洁、有条理，必要时使用 Markdown 格式。" },
    { id: "coder", emoji: "👨‍💻", name: "全栈程序员", builtin: true, desc: "代码编写、调试与架构设计",
      prompt: "你是一名资深全栈工程师。给出可运行的代码，附带简要解释；指出潜在问题与最佳实践；代码使用 Markdown 代码块并注明语言。" },
    { id: "translator", emoji: "🌐", name: "中英互译", builtin: true, desc: "地道准确的双语翻译",
      prompt: "你是专业翻译。用户输入中文则翻译成英文，输入英文则翻译成中文。只输出译文，保持原意与语气，专业术语准确。若用户明确要求其他语言则按要求翻译。" },
    { id: "writer", emoji: "✍️", name: "文案写作", builtin: true, desc: "公众号、小红书、营销文案",
      prompt: "你是资深文案专家。根据用户需求创作有感染力的文案，标题吸睛、结构清晰、语言符合目标平台风格。先给 2-3 个方向供选择。" },
    { id: "teacher", emoji: "🎓", name: "英语老师", builtin: true, desc: "语法讲解与口语陪练",
      prompt: "你是耐心的英语老师。纠正用户的语法错误并讲解原因，提供地道表达，适当扩展词汇和例句。讲解用中文，示例用英文。" },
    { id: "pm", emoji: "📊", name: "产品经理", builtin: true, desc: "需求分析、PRD 与竞品分析",
      prompt: "你是资深产品经理。擅长需求分析、用户故事拆解、PRD 撰写与竞品分析。回答结构化、可落地，多使用表格和清单。" },
    { id: "interviewer", emoji: "🎯", name: "模拟面试官", builtin: true, desc: "技术/行为面试陪练",
      prompt: "你是专业面试官。先询问用户的目标岗位，然后开始模拟面试：一次只问一个问题，根据回答追问或点评，最后给出综合评价与改进建议。" },
    { id: "xiaohongshu", emoji: "📕", name: "小红书达人", builtin: true, desc: "种草笔记与爆款标题",
      prompt: "你是小红书爆款博主。输出带 emoji 的种草风格内容，标题用数字和痛点词，正文分段简短，结尾加相关话题标签。" }
  ];

  function defaultState() {
    return {
      settings: {
        theme: "light",
        activeProviderId: "agnes",
        activeModel: "agnes-2.5-flash",
        temperature: 0.7,
        maxTokens: 2048,
        contextCount: 30,
        systemPrompt: ""
      },
      // Agent 运行参数
      agent: {
        mode: "chat",            // chat | agent
        permission: "suggest",   // suggest(建议) | auto(自动) | full(全自动)
        workspace: null,
        projectRules: "",        // 等价于 AGENTS.md：项目级长期指令
        useMcp: true
      },
      mcpServers: [],            // [{name, command, args, env}]
      providers: DEFAULT_PROVIDERS,
      masks: DEFAULT_MASKS,
      sessions: [],
      activeSessionId: null
    };
  }

  var Store = {
    state: null,

    load: function () {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          var def = defaultState();
          // 合并：保证新增的内置服务商/面具能出现在老数据里
          parsed.settings = Object.assign({}, def.settings, parsed.settings || {});
          // 旧默认只带 10 条历史，聊几轮就会"忘记"前面说过的话 → 老存档沿用旧默认值时升级为 30
          if (parsed.settings.contextCount === 10) parsed.settings.contextCount = def.settings.contextCount;
          parsed.agent = Object.assign({}, def.agent, parsed.agent || {});
          parsed.mcpServers = parsed.mcpServers || [];
          parsed.providers = parsed.providers || def.providers;
          def.providers.forEach(function (dp) {
            if (!parsed.providers.some(function (p) { return p.id === dp.id; })) {
              parsed.providers.push(dp);
            }
          });
          parsed.masks = parsed.masks || def.masks;
          def.masks.forEach(function (dm) {
            if (!parsed.masks.some(function (m) { return m.id === dm.id; })) {
              parsed.masks.push(dm);
            }
          });
          parsed.sessions = parsed.sessions || [];
          this.state = parsed;
        } else {
          this.state = defaultState();
        }
      } catch (e) {
        console.error("加载本地数据失败，使用默认配置", e);
        this.state = defaultState();
      }
      return this.state;
    },

    save: function () {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch (e) {
        console.error("保存失败", e);
      }
    },

    uid: function () {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    },

    getProvider: function (id) {
      return this.state.providers.find(function (p) { return p.id === id; });
    },

    getSession: function (id) {
      return this.state.sessions.find(function (s) { return s.id === id; });
    },

    getMask: function (id) {
      return this.state.masks.find(function (m) { return m.id === id; });
    },

    createSession: function (maskId) {
      var mask = maskId ? this.getMask(maskId) : null;
      var session = {
        id: this.uid(),
        title: mask ? mask.name : "新任务",
        maskId: maskId || null,
        workspace: this.state.agent.workspace || null,   // 归属项目，用于侧栏按项目分组
        messages: [],            // 内部格式：user / assistant / tool
        summary: null,           // 上下文压缩后的摘要（长期可见）
        compactCount: 0,         // 已压缩次数
        summaryHistory: [],      // 每次压缩前的规模快照
        todo: [],                // 任务清单
        checkpoints: {},         // 文件快照，用于回滚
        trajectory: [],          // 会话事件日志（借鉴 Harness 的 append-only session log）
        stats: { steps: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 0, totalTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      this.state.sessions.unshift(session);
      this.state.activeSessionId = session.id;
      this.save();
      return session;
    },

    /* 追加一条会话事件（模型可见的一切都应有迹可循） */
    pushTrajectory: function (session, type, label, detail) {
      if (!session) return;
      session.trajectory.push({
        ts: Date.now(),
        type: type,      // system | user | assistant | tool | permission | complete | error
        label: String(label || "").slice(0, 400),
        detail: detail ? String(detail).slice(0, 2000) : ""
      });
      if (session.trajectory.length > 300) session.trajectory.splice(0, session.trajectory.length - 300);
    },

    deleteSession: function (id) {
      var idx = this.state.sessions.findIndex(function (s) { return s.id === id; });
      if (idx >= 0) this.state.sessions.splice(idx, 1);
      if (this.state.activeSessionId === id) {
        this.state.activeSessionId = this.state.sessions.length ? this.state.sessions[0].id : null;
      }
      this.save();
    },

    exportAll: function () {
      return JSON.stringify(this.state, null, 2);
    },

    importAll: function (json) {
      var data = JSON.parse(json);
      if (!data || typeof data !== "object" || !Array.isArray(data.providers)) {
        throw new Error("数据格式不正确");
      }
      this.state = data;
      this.save();
    }
  };

  window.Store = Store;
})();

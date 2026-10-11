/* ============ CubeAgent 轻量 Markdown 渲染器（零依赖） ============ */
(function () {
  "use strict";

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* 轻量语法高亮：注释 / 字符串 / 关键字 / 数字 */
  var KEYWORDS =
    "\\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|import|export|from|default|null|undefined|true|false|void|delete|static|get|set|" +
    "def|elif|lambda|pass|raise|with|as|global|nonlocal|assert|is|not|and|or|None|True|False|self|print|len|range|str|int|float|list|dict|set|tuple|" +
    "public|private|protected|package|interface|enum|implements|final|abstract|synchronized|volatile|transient|native|throws|extends|" +
    "fn|mut|impl|trait|struct|match|pub|use|mod|where|unsafe|move|ref|" +
    "func|go|chan|defer|select|map|make|range|" +
    "SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|GROUP|BY|ORDER|HAVING|LIMIT|CREATE|TABLE|DROP|ALTER|INDEX|VALUES|INTO|SET|AND|OR|NOT|NULL)\\b";

  /* 对一段已转义的代码做高亮。store 只在单次调用内有效。 */
  function highlightOnce(escaped) {
    var store = [];
    function stash(html) {
      store.push(html);
      return "\u0001" + (store.length - 1) + "\u0001";
    }
    var out = escaped;
    // 注释（行注释与块注释）
    out = out.replace(/(\/\/[^\n]*|#[^\n]*)/g, function (m) {
      return stash('<span class="tok-c">' + m + "</span>");
    });
    out = out.replace(/(\/\*[\s\S]*?\*\/)/g, function (m) {
      return stash('<span class="tok-c">' + m + "</span>");
    });
    // 字符串
    out = out.replace(/(&quot;[\s\S]*?&quot;|&#39;[\s\S]*?&#39;|'[^'\n]*'|`[^`]*`)/g, function (m) {
      return stash('<span class="tok-s">' + m + "</span>");
    });
    // 数字
    out = out.replace(/\b(\d+\.?\d*(?:e[+-]?\d+)?)\b/gi, function (m) {
      return stash('<span class="tok-n">' + m + "</span>");
    });
    // 关键字
    out = out.replace(new RegExp(KEYWORDS, "g"), function (m) {
      return '<span class="tok-k">' + m + "</span>";
    });
    // 函数调用
    out = out.replace(/([A-Za-z_][A-Za-z0-9_]*)(?=\()/g, function (m) {
      return '<span class="tok-f">' + m + "</span>";
    });
    // 还原保护段
    out = out.replace(/\u0001(\d+)\u0001/g, function (_, i) {
      return store[+i];
    });
    return out;
  }

  /* 逐行高亮：每行包一层 .code-line，行号由 CSS counter 生成。
     必须按行切分后再高亮 —— 否则块注释 / 多行字符串的 span 会跨行闭合，
     把两个 <span> 交错成非法 HTML，浏览器会吞掉标记导致代码显示错乱。 */
  function highlightCode(escaped, lang) {
    var lines = escaped.split("\n");
    var out = "";
    for (var i = 0; i < lines.length; i++) {
      out += '<span class="code-line">' + highlightOnce(lines[i]) + "</span>";
    }
    return out;
  }

  function renderInline(s) {
    // 行内代码
    s = s.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
    // 图片占位（只显示 alt，避免加载外部资源）
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">图片 $1</a>');
    // 链接
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // 加粗 / 斜体 / 删除线
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s;
  }

  function renderTable(lines) {
    // lines: ['| a | b |', '|---|---|', '| 1 | 2 |', ...]
    function parseRow(line) {
      return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) {
        return c.trim();
      });
    }
    var html = "<table>";
    for (var i = 0; i < lines.length; i++) {
      if (i === 1 && /^\|[\s\-:|]+\|$/.test(lines[i].trim())) continue; // 分隔行
      var cells = parseRow(lines[i]);
      var tag = i === 0 ? "th" : "td";
      html += "<tr>" + cells.map(function (c) {
        return "<" + tag + ">" + renderInline(c) + "</" + tag + ">";
      }).join("") + "</tr>";
    }
    return html + "</table>";
  }

  function renderMarkdown(src) {
    if (!src) return "";
    var codeBlocks = [];

    // 1. 提取代码块（在转义之前）
    src = src.replace(/```(\w*)[ \t]*\n?([\s\S]*?)(?:```|$)/g, function (_, lang, code) {
      codeBlocks.push({ lang: lang || "text", code: code.replace(/\n$/, "") });
      return "\n\u0000CB" + (codeBlocks.length - 1) + "\u0000\n";
    });

    // 2. 转义 HTML
    src = escapeHtml(src);

    var lines = src.split("\n");
    var html = "";
    var i = 0;
    var paragraph = [];
    var listType = null; // 'ul' | 'ol'
    var inQuote = false;

    function flushParagraph() {
      if (paragraph.length) {
        html += "<p>" + renderInline(paragraph.join("<br>")) + "</p>";
        paragraph = [];
      }
    }
    function flushList() {
      if (listType) {
        html += "</" + listType + ">";
        listType = null;
      }
    }
    function flushQuote() {
      if (inQuote) {
        html += "</blockquote>";
        inQuote = false;
      }
    }

    while (i < lines.length) {
      var line = lines[i];
      var trimmed = line.trim();

      // 代码块占位
      var cbMatch = trimmed.match(/^\u0000CB(\d+)\u0000$/);
      if (cbMatch) {
        flushParagraph(); flushList(); flushQuote();
        var cb = codeBlocks[+cbMatch[1]];
        var escaped = escapeHtml(cb.code);
        /* 代码块头：文件名（可选）+ 语言 + 复制。
           行号由 CSS counter 在 ::before 里生成，不污染 DOM，
           这样复制拿到的仍是 data-code 里的纯原文。 */
        var fileName = cb.file ? String(cb.file).split(/[\\/]/).pop() : "";
        var head = fileName
          ? '<span class="code-file">' + escapeHtml(fileName) + "</span>" +
            '<span class="code-lang">' + cb.lang + "</span>"
          : '<span class="code-lang">' + cb.lang + "</span>";
        html +=
          '<div class="code-block"><div class="code-head">' + head +
          '<button class="code-copy" data-code="' + encodeURIComponent(cb.code) + '">复制</button></div>' +
          "<pre><code>" + highlightCode(escaped, cb.lang) + "</code></pre></div>";
        i++;
        continue;
      }

      // 表格
      if (trimmed.charAt(0) === "|" && i + 1 < lines.length && /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim())) {
        flushParagraph(); flushList(); flushQuote();
        var tableLines = [];
        while (i < lines.length && lines[i].trim().charAt(0) === "|") {
          tableLines.push(lines[i].trim());
          i++;
        }
        html += renderTable(tableLines);
        continue;
      }

      // 标题
      var hMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (hMatch) {
        flushParagraph(); flushList(); flushQuote();
        var level = hMatch[1].length;
        html += "<h" + level + ">" + renderInline(hMatch[2]) + "</h" + level + ">";
        i++;
        continue;
      }

      // 分割线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        flushParagraph(); flushList(); flushQuote();
        html += "<hr>";
        i++;
        continue;
      }

      // 引用
      if (/^&gt;/.test(trimmed)) {
        flushParagraph(); flushList();
        if (!inQuote) { html += "<blockquote>"; inQuote = true; }
        html += renderInline(trimmed.replace(/^&gt;\s?/, "")) + "<br>";
        i++;
        continue;
      } else { flushQuote(); }

      // 无序列表
      var ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (ulMatch) {
        flushParagraph();
        if (listType !== "ul") { flushList(); html += "<ul>"; listType = "ul"; }
        html += "<li>" + renderInline(ulMatch[2]) + "</li>";
        i++;
        continue;
      }

      // 有序列表
      var olMatch = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
      if (olMatch) {
        flushParagraph();
        if (listType !== "ol") { flushList(); html += "<ol>"; listType = "ol"; }
        html += "<li>" + renderInline(olMatch[2]) + "</li>";
        i++;
        continue;
      }

      flushList();

      // 空行
      if (trimmed === "") {
        flushParagraph();
        i++;
        continue;
      }

      paragraph.push(line);
      i++;
    }
    flushParagraph(); flushList(); flushQuote();

    return html;
  }

  window.Markdown = { render: renderMarkdown, escapeHtml: escapeHtml };
})();

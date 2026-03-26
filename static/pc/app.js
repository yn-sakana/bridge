(function () {
  const ROOM_ID = window.ROOM_ID;
  const chat = document.getElementById("chat");
  const chatInner = document.getElementById("chatInner");
  const waiting = document.getElementById("waiting");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");

  let currentAssistantEl = null;
  let currentContent = "";
  let userScrolled = false;
  let scrollLock = false;

  chat.addEventListener("scroll", () => {
    if (scrollLock) return;
    const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 50;
    userScrolled = !atBottom;
  });

  function scrollToBottom() {
    if (userScrolled) return;
    scrollLock = true;
    requestAnimationFrame(() => {
      chat.scrollTo({ top: chat.scrollHeight, behavior: "smooth" });
      setTimeout(() => { scrollLock = false; }, 200);
    });
  }

  function setStatus(connected, text) {
    statusDot.className = "status-dot " + (connected ? "connected" : "disconnected");
    statusText.textContent = text;
  }

  // --- Markdown renderer ---
  function renderMarkdown(text) {
    let html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Code blocks with language header
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const id = "cb" + Math.random().toString(36).slice(2, 8);
      const header = lang
        ? '<div class="code-header"><span class="code-lang">' + lang + '</span><button class="copy-btn" onclick="copyCode(\'' + id + "')\" data-id=\"" + id + '">copy</button></div>'
        : '<div class="code-header"><span class="code-lang">code</span><button class="copy-btn" onclick="copyCode(\'' + id + "')\" data-id=\"" + id + '">copy</button></div>';
      return '<div class="code-block">' + header + '<pre><code id="' + id + '">' + code.trim() + '</code></pre></div>';
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // Headings
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Horizontal rule
    html = html.replace(/^---$/gm, '<hr>');

    // Tables
    html = html.replace(/(?:^\|.+\|$\n?)+/gm, (table) => {
      const rows = table.trim().split("\n");
      if (rows.length < 2) return table;
      let result = '<table>';
      rows.forEach((row, i) => {
        if (i === 1 && /^\|[\s-:|]+\|$/.test(row)) return; // skip separator
        const cells = row.split("|").filter((c, ci, arr) => ci > 0 && ci < arr.length - 1);
        const tag = i === 0 ? "th" : "td";
        const wrap = i === 0 ? "thead" : (i === 2 ? "tbody" : "");
        if (wrap === "thead") result += "<thead>";
        if (wrap === "tbody") result += "</tbody><tbody>"; // close thead implicitly
        result += "<tr>" + cells.map(c => "<" + tag + ">" + c.trim() + "</" + tag + ">").join("") + "</tr>";
        if (i === 0) result += "</thead><tbody>";
      });
      result += "</tbody></table>";
      return result;
    });

    // Unordered lists
    html = html.replace(/(?:^- .+$\n?)+/gm, (block) => {
      const items = block.trim().split("\n").map(l => "<li>" + l.replace(/^- /, "") + "</li>");
      return "<ul>" + items.join("") + "</ul>";
    });

    // Ordered lists
    html = html.replace(/(?:^\d+\. .+$\n?)+/gm, (block) => {
      const items = block.trim().split("\n").map(l => "<li>" + l.replace(/^\d+\. /, "") + "</li>");
      return "<ol>" + items.join("") + "</ol>";
    });

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Bold & italic
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // Blockquotes
    html = html.replace(/(?:^&gt; .+$\n?)+/gm, (block) => {
      const content = block.replace(/^&gt; /gm, "");
      return "<blockquote>" + content + "</blockquote>";
    });

    // Paragraphs (double newline)
    html = html.split("\n\n").map(p => {
      p = p.trim();
      if (!p) return "";
      if (/^<(h[1-6]|ul|ol|table|div|pre|hr|blockquote)/.test(p)) return p;
      return "<p>" + p + "</p>";
    }).join("");

    // Single newlines → <br> (within paragraphs)
    html = html.replace(/([^>])\n([^<])/g, "$1<br>$2");

    return html;
  }

  window.copyCode = function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    navigator.clipboard.writeText(el.textContent);
    const btn = document.querySelector('[data-id="' + id + '"]');
    if (btn) {
      btn.textContent = "copied!";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = "copy"; btn.classList.remove("copied"); }, 1500);
    }
  };

  window.copyMsg = function (btn) {
    const msg = btn.closest(".msg");
    const content = msg.querySelector(".content");
    navigator.clipboard.writeText(content ? content.textContent : msg.textContent);
    btn.textContent = "copied!";
    setTimeout(() => { btn.textContent = "copy"; }, 1500);
  };

  function addMessage(role, content) {
    waiting.classList.add("hidden");
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.innerHTML =
      '<div class="content">' + renderMarkdown(content) +
      '</div><button class="msg-copy-btn" onclick="copyMsg(this)">copy</button>';
    chatInner.appendChild(div);
    scrollToBottom();
  }

  function startAssistantStream() {
    waiting.classList.add("hidden");
    currentContent = "";
    const div = document.createElement("div");
    div.className = "msg assistant";
    div.innerHTML = '<div class="content"><span class="cursor"></span></div>';
    chatInner.appendChild(div);
    currentAssistantEl = div;
    scrollToBottom();
  }

  function appendToStream(text) {
    if (!currentAssistantEl) startAssistantStream();
    currentContent += text;
    const contentEl = currentAssistantEl.querySelector(".content");
    contentEl.innerHTML = renderMarkdown(currentContent) + '<span class="cursor"></span>';
    scrollToBottom();
  }

  function endStream() {
    if (currentAssistantEl) {
      const contentEl = currentAssistantEl.querySelector(".content");
      contentEl.innerHTML = renderMarkdown(currentContent);
      const btn = document.createElement("button");
      btn.className = "msg-copy-btn";
      btn.textContent = "copy";
      btn.onclick = function () { copyMsg(this); };
      currentAssistantEl.appendChild(btn);
      currentAssistantEl = null;
      currentContent = "";
    }
  }

  // --- SSE Connection ---
  function connectSSE() {
    setStatus(true, "接続中...");
    const es = new EventSource("/api/stream/" + ROOM_ID);

    es.addEventListener("connected", (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.mobile) {
          setStatus(true, "モバイル接続中");
        } else {
          setStatus(true, "接続済み");
        }
      } catch {}
    });

    es.addEventListener("status", (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.mobile) setStatus(true, "モバイル接続中");
      } catch {}
    });

    es.addEventListener("message", (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.role === "user") {
          endStream();
          addMessage("user", d.content);
        } else if (d.role === "assistant") {
          endStream();
          addMessage("assistant", d.content);
        }
      } catch {}
    });

    es.addEventListener("text", (e) => {
      appendToStream(e.data);
    });

    es.addEventListener("done", () => {
      endStream();
    });

    es.addEventListener("error", (e) => {
      if (es.readyState === EventSource.CLOSED) {
        setStatus(false, "切断されました");
      } else if (es.readyState === EventSource.CONNECTING) {
        setStatus(false, "再接続中...");
      }
    });

    es.addEventListener("ping", () => {
      // keepalive, no action needed
    });
  }

  setStatus(true, "接続中...");
  connectSSE();
})();

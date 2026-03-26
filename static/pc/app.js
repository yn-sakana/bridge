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

  // --- Markdown renderer (marked.js) ---
  marked.use({
    breaks: true,
    gfm: true,
    renderer: {
      code({ text, lang }) {
        const id = "cb" + Math.random().toString(36).slice(2, 8);
        const label = lang || "code";
        const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return '<div class="code-block">' +
          '<div class="code-header"><span class="code-lang">' + label + '</span>' +
          '<button class="copy-btn" onclick="copyCode(\'' + id + "')\" data-id=\"" + id + '">copy</button></div>' +
          '<pre><code id="' + id + '">' + escaped + '</code></pre></div>';
      },
      link({ href, text }) {
        return '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>';
      }
    }
  });

  function renderMarkdown(text) {
    return marked.parse(text);
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

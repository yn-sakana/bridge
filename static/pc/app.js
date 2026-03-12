(function () {
  const ROOM_ID = window.ROOM_ID;
  const chat = document.getElementById("chat");
  const waiting = document.getElementById("waiting");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");

  let currentAssistantEl = null;
  let currentContent = "";
  let autoScroll = true;

  chat.addEventListener("scroll", () => {
    autoScroll = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 50;
  });

  function scrollToBottom() {
    if (autoScroll) chat.scrollTop = chat.scrollHeight;
  }

  function setStatus(connected, text) {
    statusDot.className =
      "status-dot " + (connected ? "connected" : "disconnected");
    statusText.textContent = text;
  }

  // --- Lightweight Markdown ---
  function renderMarkdown(text) {
    let html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const id = "cb" + Math.random().toString(36).slice(2, 8);
      return (
        '<pre><code id="' +
        id +
        '">' +
        code.trim() +
        "</code>" +
        '<button class="copy-btn" onclick="copyCode(\'' +
        id +
        "')\">copy</button></pre>"
      );
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    // Italic
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // Paragraphs
    html = html
      .split("\n\n")
      .map((p) => "<p>" + p + "</p>")
      .join("");
    html = html.replace(/\n/g, "<br>");

    return html;
  }

  window.copyCode = function (id) {
    const el = document.getElementById(id);
    if (el) navigator.clipboard.writeText(el.textContent);
  };

  function addMessage(role, content) {
    waiting.classList.add("hidden");
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.innerHTML =
      '<div class="role">' +
      role +
      '</div><div class="content">' +
      renderMarkdown(content) +
      "</div>";
    chat.appendChild(div);
    scrollToBottom();
  }

  function startAssistantStream() {
    waiting.classList.add("hidden");
    currentContent = "";
    const div = document.createElement("div");
    div.className = "msg assistant";
    div.innerHTML =
      '<div class="role">assistant</div><div class="content"><span class="cursor"></span></div>';
    chat.appendChild(div);
    currentAssistantEl = div;
    scrollToBottom();
  }

  function appendToStream(text) {
    if (!currentAssistantEl) startAssistantStream();
    currentContent += text;
    const contentEl = currentAssistantEl.querySelector(".content");
    contentEl.innerHTML =
      renderMarkdown(currentContent) + '<span class="cursor"></span>';
    scrollToBottom();
  }

  function endStream() {
    if (currentAssistantEl) {
      const contentEl = currentAssistantEl.querySelector(".content");
      contentEl.innerHTML = renderMarkdown(currentContent);
      currentAssistantEl = null;
      currentContent = "";
    }
  }

  // --- SSE ---
  function connect() {
    setStatus(false, "接続中...");
    const es = new EventSource("/api/stream/" + ROOM_ID);

    es.addEventListener("connected", (e) => {
      setStatus(true, "接続済み");
    });

    es.addEventListener("status", (e) => {
      const data = JSON.parse(e.data);
      if (data.mobile) setStatus(true, "モバイル接続中");
    });

    es.addEventListener("message", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.role === "user") {
          endStream();
          addMessage("user", data.content);
        } else if (data.role === "assistant") {
          endStream();
          addMessage("assistant", data.content);
        }
      } catch {}
    });

    // Raw SSE from fin-hub relay
    es.addEventListener("raw", (e) => {
      const lines = e.data.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          try {
            const parsed = JSON.parse(payload);
            if (parsed.text) appendToStream(parsed.text);
            else if (parsed.content) appendToStream(parsed.content);
          } catch {
            if (payload.trim()) appendToStream(payload);
          }
        }
      }
    });

    es.addEventListener("done", () => endStream());
    es.addEventListener("error", () => endStream());
    es.addEventListener("ping", () => {}); // keep alive

    es.onerror = () => setStatus(false, "再接続中...");
  }

  connect();
})();

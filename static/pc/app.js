(function () {
  const ROOM_ID = window.ROOM_ID;
  const chat = document.getElementById("chat");
  const waiting = document.getElementById("waiting");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");

  let currentAssistantEl = null;
  let currentContent = "";
  let nextIndex = 0;

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
      chat.scrollTop = chat.scrollHeight;
      scrollLock = false;
    });
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

  function handleEvent(event, data) {
    if (event === "status") {
      try {
        const d = JSON.parse(data);
        if (d.mobile) setStatus(true, "モバイル接続中");
      } catch {}
    } else if (event === "message") {
      try {
        const d = JSON.parse(data);
        if (d.role === "user") {
          endStream();
          addMessage("user", d.content);
        } else if (d.role === "assistant") {
          endStream();
          addMessage("assistant", d.content);
        }
      } catch {}
    } else if (event === "text") {
      appendToStream(data);
    } else if (event === "done") {
      endStream();
    } else if (event === "error") {
      endStream();
    }
  }

  // --- Polling ---
  let polling = true;
  let pollInterval = 2000;
  const POLL_FAST = 500;
  const POLL_IDLE = 2000;

  async function poll() {
    if (!polling) return;
    try {
      const resp = await fetch("/api/events/" + ROOM_ID + "?after=" + nextIndex);
      if (resp.status === 410) {
        setStatus(false, "ルーム期限切れ");
        polling = false;
        return;
      }
      if (!resp.ok) {
        setStatus(false, "エラー");
        setTimeout(poll, 5000);
        return;
      }
      const body = await resp.json();

      if (body.mobile) {
        setStatus(true, "モバイル接続中");
      } else {
        setStatus(true, "接続済み");
      }

      const events = body.events || [];
      for (const ev of events) {
        handleEvent(ev.event, ev.data);
      }
      nextIndex = body.next;

      // Poll faster when streaming
      pollInterval = events.length > 0 ? POLL_FAST : POLL_IDLE;
    } catch {
      setStatus(false, "再接続中...");
      pollInterval = 5000;
    }
    setTimeout(poll, pollInterval);
  }

  setStatus(true, "接続済み");
  poll();
})();

(function () {
  // --- State ---
  let config = { provider: "", model: "", temperature: 0.7, system_prompt: "" };
  let roomId = null;
  let sessionId = null;
  let messages = [];
  let streaming = false;
  let inputMode = false;

  // --- Elements ---
  const $ = (id) => document.getElementById(id);
  const statusDot = $("statusDot");
  const statusDot2 = $("statusDot2");
  const statusText = $("statusText");
  const roomUrlEl = $("roomUrl");
  const roomUrlText = $("roomUrlText");
  const selProvider = $("selProvider");
  const selModel = $("selModel");
  const selThinking = $("selThinking");
  const selThinking2 = $("selThinking2");
  const selProvider2 = $("selProvider2");
  const selModel2 = $("selModel2");
  const txtPrompt = $("txtPrompt");
  const btnSend = $("btnSend");
  const sessionIdEl = $("sessionId");
  const btnNewSession = $("btnNewSession");
  const btnNewSession2 = $("btnNewSession2");
  const chatArea = $("chatArea");
  const cfgTemp = $("cfgTemp");
  const cfgTempVal = $("cfgTempVal");
  const cfgSystem = $("cfgSystem");
  const overlaySettings = $("overlaySettings");
  const btnMode = $("btnMode");

  let currentAssistantEl = null;
  let currentContent = "";
  let autoScroll = true;

  // --- Auto-scroll (ChatGPT style) ---
  chatArea.addEventListener("scroll", () => {
    autoScroll = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 50;
  });

  function scrollToBottom() {
    if (autoScroll) chatArea.scrollTop = chatArea.scrollHeight;
  }

  // --- Mode toggle ---
  function applyMode() {
    document.body.classList.toggle("input-mode", inputMode);
    btnMode.classList.toggle("active", inputMode);
    // mode is session-only, not persisted
  }
  applyMode();

  btnMode.onclick = () => {
    inputMode = !inputMode;
    applyMode();
    txtPrompt.focus();
  };

  // --- Sync compact selects with full selects ---
  function syncProvider2() {
    selProvider2.innerHTML = selProvider.innerHTML;
    selProvider2.value = selProvider.value;
  }
  function syncModel2() {
    selModel2.innerHTML = selModel.innerHTML;
    selModel2.value = selModel.value;
  }

  selProvider.onchange = () => {
    syncProvider2();
    loadModels();
  };
  selProvider2.onchange = () => {
    selProvider.value = selProvider2.value;
    loadModels();
  };
  selModel.onchange = () => { syncModel2(); saveConfig(); };
  selModel2.onchange = () => { selModel.value = selModel2.value; saveConfig(); };

  // --- Init ---
  newSession();
  (async () => {
    await loadConfig();
    syncProvider2();
    await loadModels();
    // Restore saved model after list is loaded
    if (config.model) {
      selModel.value = config.model;
      syncModel2();
    }
  })();

  txtPrompt.addEventListener("input", () => {
    if (!inputMode) {
      txtPrompt.style.height = "auto";
      txtPrompt.style.height = Math.min(txtPrompt.scrollHeight, 200) + "px";
    }
  });

  // --- Settings overlay ---
  const cfgProvider = $("cfgProvider");
  const cfgModel = $("cfgModel");
  const cfgRoomField = $("cfgRoomField");
  const cfgRoomUrl = $("cfgRoomUrl");

  $("btnSettings").onclick = () => {
    cfgTemp.value = config.temperature;
    cfgTempVal.textContent = config.temperature;
    cfgSystem.value = config.system_prompt;
    selThinking2.value = selThinking.value;
    // Sync provider/model into overlay
    cfgProvider.innerHTML = selProvider.innerHTML;
    cfgProvider.value = selProvider.value;
    cfgModel.innerHTML = selModel.innerHTML;
    cfgModel.value = selModel.value;
    // Show room URL if available
    if (roomId) {
      cfgRoomField.style.display = "";
      cfgRoomUrl.textContent = roomUrlText.textContent;
    }
    overlaySettings.classList.add("active");
  };
  cfgProvider.onchange = () => {
    selProvider.value = cfgProvider.value;
    syncProvider2();
    loadModels().then(() => {
      cfgModel.innerHTML = selModel.innerHTML;
      cfgModel.value = selModel.value;
    });
  };
  cfgModel.onchange = () => {
    selModel.value = cfgModel.value;
    syncModel2();
  };
  $("btnSettingsCancel").onclick = () =>
    overlaySettings.classList.remove("active");
  $("btnSettingsSave").onclick = () => {
    config.temperature = parseFloat(cfgTemp.value);
    config.system_prompt = cfgSystem.value;
    selThinking.value = selThinking2.value;
    selProvider.value = cfgProvider.value;
    selModel.value = cfgModel.value;
    syncProvider2();
    syncModel2();
    saveConfig();
    overlaySettings.classList.remove("active");
  };
  cfgTemp.oninput = () => (cfgTempVal.textContent = cfgTemp.value);

  // --- Room ---
  async function createRoom() {
    try {
      const res = await fetch("/api/room", { method: "POST" });
      if (!res.ok) throw new Error("Room creation failed: " + res.status);
      const data = await res.json();
      roomId = data.room_id;
      roomUrlText.textContent = data.url;
      roomUrlEl.classList.add("active");
      setStatus("waiting", "PC接続待ち...");

      // Generate QR code
      const qrImg = document.getElementById("qrImg");
      qrImg.src = "https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=" + encodeURIComponent(data.url);
      qrImg.style.display = "block";
    } catch (e) {
      alert("ルーム作成エラー: " + e.message);
    }
  }

  createRoom();

  // --- Markdown renderer (marked.js) ---
  const renderer = new marked.Renderer();
  renderer.code = function ({ text, lang }) {
    const id = "cb" + Math.random().toString(36).slice(2, 8);
    const label = lang || "code";
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return '<div class="code-block">' +
      '<div class="code-header"><span class="code-lang">' + label + '</span>' +
      '<button class="copy-btn" onclick="copyCode(\'' + id + "')\" data-id=\"" + id + '">copy</button></div>' +
      '<pre><code id="' + id + '">' + escaped + '</code></pre></div>';
  };
  renderer.link = function ({ href, text }) {
    return '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>';
  };
  marked.setOptions({ renderer, breaks: true, gfm: true });

  function renderMarkdown(text) {
    return marked.parse(text);
  }

  // Tap message to show/hide copy button on mobile
  chatArea.addEventListener("click", (e) => {
    const msg = e.target.closest(".msg");
    if (!msg || e.target.closest(".msg-copy-btn,.copy-btn")) return;
    msg.classList.toggle("show-copy");
  });

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
    const content = msg.querySelector(".msg-content");
    navigator.clipboard.writeText(content ? content.textContent : msg.textContent);
    btn.textContent = "copied";
    setTimeout(() => { btn.textContent = "copy"; }, 1500);
  };

  // --- Chat display ---
  function addChatMessage(role, content) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.innerHTML = '<div class="msg-content">' + renderMarkdown(content) + '</div>' +
      '<button class="msg-copy-btn" onclick="copyMsg(this)">copy</button>';
    chatArea.appendChild(div);
    scrollToBottom();
  }

  function startAssistantStream() {
    currentContent = "";
    currentAssistantEl = document.createElement("div");
    currentAssistantEl.className = "msg assistant";
    currentAssistantEl.innerHTML = '<div class="msg-content"><span class="cursor"></span></div>';
    chatArea.appendChild(currentAssistantEl);
    scrollToBottom();
  }

  function appendToStream(text) {
    if (!currentAssistantEl) startAssistantStream();
    currentContent += text;
    const contentEl = currentAssistantEl.querySelector(".msg-content");
    contentEl.innerHTML = renderMarkdown(currentContent) + '<span class="cursor"></span>';
    scrollToBottom();
  }

  function endStream() {
    if (currentAssistantEl) {
      const contentEl = currentAssistantEl.querySelector(".msg-content");
      contentEl.innerHTML = renderMarkdown(currentContent);
      // Add copy button
      const btn = document.createElement("button");
      btn.className = "msg-copy-btn";
      btn.textContent = "copy";
      btn.onclick = function () { copyMsg(this); };
      currentAssistantEl.appendChild(btn);
      currentAssistantEl = null;
    }
  }

  // --- Send ---
  btnSend.onclick = sendMessage;
  txtPrompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  async function sendMessage() {
    const text = txtPrompt.value.trim();
    if (!text || streaming) return;
    if (!roomId) {
      await createRoom();
      if (!roomId) return;
    }

    messages.push({ role: "user", content: text });
    addChatMessage("user", text);
    txtPrompt.value = "";
    txtPrompt.style.height = "auto";
    streaming = true;
    updateUI();

    // Hide room info and settings after first message
    roomUrlEl.classList.remove("active");
    document.body.classList.add("chatting");

    try {
      const body = {
        room_id: roomId,
        messages: messages,
        provider: selProvider.value,
        model: selModel.value,
        temperature: config.temperature,
        max_tokens: null,
        system_prompt: config.system_prompt || "",
        session_id: sessionId,
        thinking_mode: selThinking.value || "",
        reasoning_effort:
          selThinking.value && selThinking.value !== "auto"
            ? selThinking.value
            : null,
      };

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("Chat failed: " + res.status);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";
      let currentEvent = "";
      let dataLines = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          const trimmed = line.trimEnd();
          if (trimmed.startsWith("event:")) {
            currentEvent = trimmed.slice(6).trim();
          } else if (trimmed.startsWith("data:")) {
            dataLines.push(trimmed.slice(5).trim());
          } else if (trimmed === "") {
            // Blank line = dispatch event
            if (currentEvent && dataLines.length) {
              const data = dataLines.join("\n");
              if (currentEvent === "text") {
                assistantContent += data;
                appendToStream(data);
              } else if (currentEvent === "done") {
                endStream();
              } else if (currentEvent === "error") {
                endStream();
                try {
                  const err = JSON.parse(data);
                  addChatMessage("assistant", "Error: " + (err.message || data));
                } catch {
                  addChatMessage("assistant", "Error: " + data);
                }
              }
            }
            currentEvent = "";
            dataLines = [];
          }
        }
      }

      endStream();
      if (assistantContent) {
        messages.push({ role: "assistant", content: assistantContent });
      }
    } catch (e) {
      endStream();
      console.error("Send error:", e);
      addChatMessage("assistant", "Error: " + e.message);
    } finally {
      streaming = false;
      updateUI();
    }
  }

  // --- Session ---
  btnNewSession.onclick = () => newSession();
  btnNewSession2.onclick = () => newSession();

  function newSession() {
    sessionId = crypto.randomUUID().slice(0, 8);
    messages = [];
    chatArea.innerHTML = "";
    currentAssistantEl = null;
    currentContent = "";
    sessionIdEl.textContent = sessionId;
  }

  // --- Models ---
  async function loadModels() {
    selModel.innerHTML = '<option value="">読み込み中...</option>';
    selModel.disabled = true;
    syncModel2();
    try {
      const res = await fetch("/api/models/" + selProvider.value);
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      selModel.innerHTML = "";
      const models = data.models || data;
      if (Array.isArray(models)) {
        models.forEach((m) => {
          const name = typeof m === "string" ? m : m.id || m.name || m.model;
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          selModel.appendChild(opt);
        });
      }
    } catch {
      selModel.innerHTML = '<option value="">取得失敗</option>';
    } finally {
      selModel.disabled = false;
      syncModel2();
    }
  }

  // --- Status ---
  function setStatus(state, text) {
    statusDot.className = "status-dot " + state;
    statusDot2.className = "status-dot " + state;
    statusText.textContent = text;
  }

  function updateUI() {
    btnSend.disabled = streaming;
    if (streaming) {
      setStatus("waiting", "ストリーミング中...");
    } else if (roomId) {
      setStatus("connected", "ルーム: " + roomId);
    }
  }

  // --- Config (server-side yaml) ---
  async function loadConfig() {
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const data = await res.json();
        Object.assign(config, data);
        if (data.provider) selProvider.value = data.provider;
        if (data.temperature != null) config.temperature = data.temperature;
        if (data.system_prompt != null) config.system_prompt = data.system_prompt;
      }
    } catch {}
  }
  async function saveConfig() {
    try {
      await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selProvider.value,
          model: selModel.value,
          temperature: config.temperature,
          system_prompt: config.system_prompt,
        }),
      });
    } catch {}
  }
})();

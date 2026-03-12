(function () {
  // --- State ---
  let config = { temperature: 0.7, system_prompt: "" };
  let roomId = null;
  let sessionId = null;
  let messages = [];
  let streaming = false;
  let inputMode = localStorage.getItem("bridge_mode") === "input";

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
    localStorage.setItem("bridge_mode", inputMode ? "input" : "standalone");
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
  selModel.onchange = () => syncModel2();
  selModel2.onchange = () => { selModel.value = selModel2.value; };

  // --- Init ---
  loadConfig();
  newSession();
  syncProvider2();
  loadModels();

  txtPrompt.addEventListener("input", () => {
    if (!inputMode) {
      txtPrompt.style.height = "auto";
      txtPrompt.style.height = Math.min(txtPrompt.scrollHeight, 200) + "px";
    }
  });

  // --- Settings ---
  $("btnSettings").onclick = () => {
    cfgTemp.value = config.temperature;
    cfgTempVal.textContent = config.temperature;
    cfgSystem.value = config.system_prompt;
    selThinking2.value = selThinking.value;
    overlaySettings.classList.add("active");
  };
  $("btnSettingsCancel").onclick = () =>
    overlaySettings.classList.remove("active");
  $("btnSettingsSave").onclick = () => {
    config.temperature = parseFloat(cfgTemp.value);
    config.system_prompt = cfgSystem.value;
    selThinking.value = selThinking2.value;
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

  // --- Chat display ---
  function addChatMessage(role, content) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.textContent = content;
    chatArea.appendChild(div);
    scrollToBottom();
  }

  function startAssistantStream() {
    currentContent = "";
    currentAssistantEl = document.createElement("div");
    currentAssistantEl.className = "msg assistant";
    currentAssistantEl.innerHTML = '<span class="cursor"></span>';
    chatArea.appendChild(currentAssistantEl);
    scrollToBottom();
  }

  function appendToStream(text) {
    if (!currentAssistantEl) startAssistantStream();
    currentContent += text;
    currentAssistantEl.textContent = currentContent;
    scrollToBottom();
  }

  function endStream() {
    if (currentAssistantEl) {
      currentAssistantEl.textContent = currentContent;
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          const trimmed = line.trimEnd();
          if (trimmed.startsWith("event:")) {
            currentEvent = trimmed.slice(6).trim();
          } else if (trimmed.startsWith("data:")) {
            const data = trimmed.slice(5).trim();
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
            currentEvent = "";
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

  // --- Config persistence ---
  function loadConfig() {
    try {
      const saved = localStorage.getItem("bridge_config");
      if (saved) Object.assign(config, JSON.parse(saved));
    } catch {}
  }
  function saveConfig() {
    localStorage.setItem("bridge_config", JSON.stringify(config));
  }
})();

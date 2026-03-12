(function () {
  // --- State ---
  let config = { temperature: 0.7, system_prompt: "" };
  let roomId = null;
  let sessionId = null;
  let messages = [];
  let streaming = false;

  // --- Elements ---
  const $ = (id) => document.getElementById(id);
  const statusDot = $("statusDot");
  const statusText = $("statusText");
  const roomUrlEl = $("roomUrl");
  const roomUrlText = $("roomUrlText");
  const selProvider = $("selProvider");
  const selModel = $("selModel");
  const selThinking = $("selThinking");
  const txtPrompt = $("txtPrompt");
  const btnSend = $("btnSend");
  const sessionIdEl = $("sessionId");
  const btnNewSession = $("btnNewSession");
  const chatArea = $("chatArea");
  const chkShowChat = $("chkShowChat");
  const cfgTemp = $("cfgTemp");
  const cfgTempVal = $("cfgTempVal");
  const cfgSystem = $("cfgSystem");
  const overlaySettings = $("overlaySettings");

  let currentAssistantEl = null;
  let currentContent = "";

  // --- Init ---
  loadConfig();
  newSession();

  // Chat visibility toggle
  chkShowChat.checked = localStorage.getItem("bridge_show_chat") !== "false";
  chatArea.classList.toggle("hidden", !chkShowChat.checked);
  chkShowChat.onchange = () => {
    chatArea.classList.toggle("hidden", !chkShowChat.checked);
    localStorage.setItem("bridge_show_chat", chkShowChat.checked);
  };

  txtPrompt.addEventListener("input", () => {
    txtPrompt.style.height = "auto";
    txtPrompt.style.height = Math.min(txtPrompt.scrollHeight, 200) + "px";
  });

  // --- Settings ---
  $("btnSettings").onclick = () => {
    cfgTemp.value = config.temperature;
    cfgTempVal.textContent = config.temperature;
    cfgSystem.value = config.system_prompt;
    overlaySettings.classList.add("active");
  };
  $("btnSettingsCancel").onclick = () =>
    overlaySettings.classList.remove("active");
  $("btnSettingsSave").onclick = () => {
    config.temperature = parseFloat(cfgTemp.value);
    config.system_prompt = cfgSystem.value;
    saveConfig();
    overlaySettings.classList.remove("active");
  };
  cfgTemp.oninput = () => (cfgTempVal.textContent = cfgTemp.value);

  // --- Provider / Model ---
  selProvider.onchange = () => loadModels();
  loadModels();

  // --- Room ---
  async function createRoom() {
    try {
      const res = await fetch("/api/room", {
        method: "POST",
      });
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
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function startAssistantStream() {
    currentContent = "";
    currentAssistantEl = document.createElement("div");
    currentAssistantEl.className = "msg assistant";
    currentAssistantEl.innerHTML = '<span class="cursor"></span>';
    chatArea.appendChild(currentAssistantEl);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function appendToStream(text) {
    if (!currentAssistantEl) startAssistantStream();
    currentContent += text;
    currentAssistantEl.textContent = currentContent;
    chatArea.scrollTop = chatArea.scrollHeight;
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
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("Chat failed: " + res.status);

      // Parse SSE stream (fin-hub format: event: text, data: raw text)
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
    try {
      const res = await fetch("/api/models/" + selProvider.value);
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      selModel.innerHTML = "";
      const models = data.models || data;
      if (Array.isArray(models)) {
        models.forEach((m) => {
          const name =
            typeof m === "string" ? m : m.id || m.name || m.model;
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
    }
  }

  // --- Status ---
  function setStatus(state, text) {
    statusDot.className = "status-dot " + state;
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

  // --- Config persistence (localStorage on trusted mobile) ---
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

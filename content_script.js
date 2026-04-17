(function initVoiceToPrompt() {
  if (window.__voiceToPromptInitialized) return;
  window.__voiceToPromptInitialized = true;

  const STORAGE_KEY = "voiceToPromptSettings";
  const DEFAULT_SETTINGS = {
    language: "en_us",
    assemblyApiKey: "",
    eraseCodeword: "apple",
    panelShortcut: "Ctrl+Shift+V",
  };
  const SILENCE_AUTO_STOP_MS = 2800;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    focusedEditable: null,
    isRecording: false,
    mediaStream: null,
    audioContext: null,
    sourceNode: null,
    processorNode: null,
    ws: null,
    wsReady: false,
    turnCache: {},
    pendingTranscript: "",
    silenceTimer: null,
    recordTarget: null,
    livePreview: null,
    drag: {
      active: false,
      offsetX: 0,
      offsetY: 0,
    },
    lastShortcutToggleAt: 0,
    wsConnectTimer: null,
  };

  const ui = createUI();
  loadSettings();
  watchFocusChanges();
  watchGlobalStopTriggers();
  watchPanelShortcut();
  syncInitialFocusedField();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "VOICE_TO_PROMPT_TOGGLE") {
      const now = Date.now();
      if (now - state.lastShortcutToggleAt < 300) {
        return;
      }
      togglePanelVisibility();
    }
  });

  function loadSettings() {
    chrome.storage.sync.get([STORAGE_KEY], (result) => {
      if (chrome.runtime.lastError) return;
      state.settings = { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEY] || {}) };
      if (ui.eraseInput) {
        ui.eraseInput.value = state.settings.eraseCodeword || DEFAULT_SETTINGS.eraseCodeword;
      }
      if (ui.shortcutInput) {
        ui.shortcutInput.value = state.settings.panelShortcut || DEFAULT_SETTINGS.panelShortcut;
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes[STORAGE_KEY]) return;
      state.settings = { ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY].newValue || {}) };
      if (ui.eraseInput) {
        ui.eraseInput.value = state.settings.eraseCodeword || DEFAULT_SETTINGS.eraseCodeword;
      }
      if (ui.shortcutInput) {
        ui.shortcutInput.value = state.settings.panelShortcut || DEFAULT_SETTINGS.panelShortcut;
      }
    });
  }

  function syncInitialFocusedField() {
    const active = document.activeElement;
    if (isEditableElement(active)) {
      state.focusedEditable = active;
      updatePanelForFocus(active);
      return;
    }
    ui.target.textContent = "Focused: none";
  }

  function watchFocusChanges() {
    document.addEventListener("focusin", (event) => {
      const target = event.target;
      if (!isEditableElement(target)) return;
      state.focusedEditable = target;
      updatePanelForFocus(target);
    });

    document.addEventListener("focusout", () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (isEditableElement(active)) {
          state.focusedEditable = active;
          updatePanelForFocus(active);
          return;
        }
        if (active instanceof Node && ui.panel.contains(active)) {
          return;
        }
        state.focusedEditable = null;
        ui.target.textContent = "Focused: none";
      }, 0);
    });
  }

  function watchPanelShortcut() {
    document.addEventListener(
      "keydown",
      (event) => {
        if (!matchesShortcut(event, state.settings.panelShortcut || DEFAULT_SETTINGS.panelShortcut)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        state.lastShortcutToggleAt = Date.now();
        togglePanelVisibility();
      },
      true
    );
  }

  function watchGlobalStopTriggers() {
    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target;
        if (target instanceof Node && ui.panel.contains(target)) {
          return;
        }
        if (state.isRecording) {
          stopLiveStreaming(false, { hidePanelAfterStop: true });
        }
      },
      true
    );
  }

  function toggleRecording() {
    if (!state.focusedEditable || !isEditableElement(state.focusedEditable)) {
      showPanel();
      setStatus("Focus an editable field first.");
      return;
    }
    if (state.isRecording) {
      stopLiveStreaming(false, { hidePanelAfterStop: false });
      return;
    }
    startLiveStreaming();
  }

  function togglePanelVisibility() {
    if (!ui.panel.classList.contains("vtp-visible")) {
      showPanel();
      return;
    }
    // Panel already open: shortcut starts or stops listening (does not close the panel).
    toggleRecording();
  }

  function clearWsConnectTimer() {
    if (state.wsConnectTimer) {
      window.clearTimeout(state.wsConnectTimer);
      state.wsConnectTimer = null;
    }
  }

  async function startLiveStreaming() {
    clearWsConnectTimer();
    setLoading(true, "Preparing…");
    try {
      setLoading(true, "Connecting to service…");
      const tokenResponse = await sendRuntimeMessage({ type: "VOICE_TO_PROMPT_GET_STREAM_TOKEN" });
      if (!tokenResponse?.ok || !tokenResponse.token) {
        throw new Error(tokenResponse?.error || "Could not create streaming token.");
      }

      setLoading(true, "Requesting microphone…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const audioContext = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      const targetSampleRate = 16000;
      const speechModel = selectStreamingModel(state.settings.language);
      const endpoint = `wss://streaming.assemblyai.com/v3/ws?sample_rate=${targetSampleRate}&format_turns=true&formatted_finals=true&speech_model=${speechModel}&token=${encodeURIComponent(tokenResponse.token)}`;
      setLoading(true, "Opening live session…");
      const ws = new WebSocket(endpoint);

      state.recordTarget = state.focusedEditable;
      state.turnCache = {};
      state.pendingTranscript = "";
      state.livePreview = createLivePreview(state.recordTarget);
      clearSilenceTimer();
      state.isRecording = true;
      state.mediaStream = stream;
      state.audioContext = audioContext;
      state.sourceNode = sourceNode;
      state.processorNode = processorNode;
      state.ws = ws;
      state.wsReady = false;

      state.wsConnectTimer = window.setTimeout(() => {
        state.wsConnectTimer = null;
        if (state.isRecording && !state.wsReady) {
          setLoading(false);
          setStatus("Connection timed out. Try again.");
          stopLiveStreaming(true);
        }
      }, 20000);

      ws.onopen = () => {
        clearWsConnectTimer();
        state.wsReady = true;
        sourceNode.connect(processorNode);
        processorNode.connect(audioContext.destination);
        setLoading(false);
        setRecordingUI(true);
        setStatus("Listening... speak naturally, auto-stop on silence.");
      };

      ws.onmessage = (event) => {
        handleStreamingMessage(event.data);
      };

      ws.onerror = () => {
        clearWsConnectTimer();
        setLoading(false);
        stopLiveStreaming(true);
        setStatus("Live connection failed.");
      };

      ws.onclose = () => {
        state.wsReady = false;
      };

      processorNode.onaudioprocess = (event) => {
        if (!state.isRecording || !state.wsReady || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
          return;
        }
        const input = event.inputBuffer.getChannelData(0);
        const pcm16 = convertFloat32ToInt16(input, audioContext.sampleRate, targetSampleRate);
        if (pcm16.byteLength > 0) {
          state.ws.send(pcm16);
        }
      };
    } catch (error) {
      clearWsConnectTimer();
      setLoading(false);
      setRecordingUI(false);
      stopLiveStreaming(true);
      setStatus(error?.message || "Microphone permission denied or unavailable.");
    }
  }

  function stopLiveStreaming(force = false, options = {}) {
    const { hidePanelAfterStop = false } = options;
    const hadActiveSession =
      state.isRecording || Boolean(state.mediaStream || state.ws || state.audioContext || state.processorNode);
    clearWsConnectTimer();
    setLoading(false);
    if (!state.isRecording && !force) return;
    state.isRecording = false;
    setRecordingUI(false);
    clearSilenceTimer();
    if (!force) {
      setLoading(true, "Finishing…");
      const parsed = applyEraseCodewordCommands(state.pendingTranscript, state.settings.eraseCodeword);
      const finalText = parsed.text.trim();
      if (finalText) {
        finalizeLivePreview(finalText, parsed.backspaces);
        setLoading(false);
        setStatus("Transcript inserted.");
      } else {
        if (parsed.backspaces > 0) {
          finalizeLivePreview("", parsed.backspaces);
          setLoading(false);
          setStatus("Applied erase command.");
        } else {
          clearLivePreviewText();
          setLoading(false);
          setStatus("No speech detected.");
        }
      }
    } else {
      setLoading(false);
      if (hadActiveSession) {
        setStatus("Stopped.");
      }
    }

    if (state.processorNode) {
      state.processorNode.onaudioprocess = null;
      try {
        state.processorNode.disconnect();
      } catch (_error) {
        // no-op
      }
    }
    if (state.sourceNode) {
      try {
        state.sourceNode.disconnect();
      } catch (_error) {
        // no-op
      }
    }
    if (state.audioContext) {
      state.audioContext.close();
    }
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((track) => track.stop());
    }

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "Terminate" }));
      state.ws.close();
    } else if (state.ws && state.ws.readyState === WebSocket.CONNECTING) {
      state.ws.close();
    }

    state.processorNode = null;
    state.sourceNode = null;
    state.audioContext = null;
    state.mediaStream = null;
    state.ws = null;
    state.wsReady = false;
    state.pendingTranscript = "";
    state.recordTarget = null;
    state.livePreview = null;

    if (hidePanelAfterStop) {
      hidePanel();
    } else {
      showPanel();
    }
  }

  function createUI() {
    const panel = document.createElement("aside");
    panel.className = "vtp-panel";

    const header = document.createElement("div");
    header.className = "vtp-header";
    const title = document.createElement("div");
    title.className = "vtp-title";
    title.textContent = "Voice To Prompt";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "vtp-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.isRecording) {
        stopLiveStreaming(false, { hidePanelAfterStop: true });
      } else {
        hidePanel();
      }
    });
    header.append(title, closeBtn);

    const targetRow = document.createElement("div");
    targetRow.className = "vtp-row";
    const targetIcon = document.createElement("span");
    targetIcon.className = "vtp-row-icon";
    targetIcon.textContent = "◎";
    const target = document.createElement("div");
    target.className = "vtp-target";
    target.textContent = "Focused: none";
    targetRow.append(targetIcon, target);

    const mode = document.createElement("div");
    mode.className = "vtp-mode";
    mode.textContent = "Shortcut: open · toggle dictation when open";

    const controlRow = document.createElement("div");
    controlRow.className = "vtp-control-row";
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "vtp-toggle-btn";
    toggleBtn.textContent = "Start";
    const shortcutInput = document.createElement("input");
    shortcutInput.type = "text";
    shortcutInput.className = "vtp-shortcut-input";
    shortcutInput.placeholder = "Set shortcut";
    shortcutInput.readOnly = true;
    controlRow.append(toggleBtn, shortcutInput);

    const eraseRow = document.createElement("div");
    eraseRow.className = "vtp-erase-row";
    const eraseLabel = document.createElement("label");
    eraseLabel.className = "vtp-erase-label";
    eraseLabel.textContent = "Erase key";
    const eraseInput = document.createElement("input");
    eraseInput.className = "vtp-erase-input";
    eraseInput.type = "text";
    eraseInput.placeholder = "apple";
    eraseInput.maxLength = 32;
    eraseInput.spellcheck = false;
    eraseRow.append(eraseLabel, eraseInput);

    const statusRow = document.createElement("div");
    statusRow.className = "vtp-row";
    const statusIcon = document.createElement("span");
    statusIcon.className = "vtp-row-icon";
    statusIcon.textContent = "◧";
    const statusWrap = document.createElement("div");
    statusWrap.className = "vtp-status-wrap";
    const statusSpinner = document.createElement("span");
    statusSpinner.className = "vtp-spinner";
    statusSpinner.setAttribute("aria-hidden", "true");
    const status = document.createElement("div");
    status.className = "vtp-status";
    status.textContent = "Ready";
    statusWrap.append(statusSpinner, status);
    statusRow.append(statusIcon, statusWrap);

    panel.append(header, targetRow, mode, controlRow, eraseRow, statusRow);
    document.documentElement.append(panel);
    enableDrag(panel, title);
    toggleBtn.addEventListener("click", () => {
      toggleRecording();
    });
    shortcutInput.addEventListener("keydown", (event) => captureShortcutFromPanel(event, shortcutInput));
    shortcutInput.addEventListener("focus", () => {
      shortcutInput.value = "Press keys...";
    });
    shortcutInput.addEventListener("blur", () => {
      shortcutInput.value = state.settings.panelShortcut || DEFAULT_SETTINGS.panelShortcut;
    });
    eraseInput.addEventListener("change", () => saveEraseCodewordFromPanel(eraseInput.value));
    eraseInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        eraseInput.blur();
      }
    });
    return { panel, target, mode, status, statusSpinner, eraseInput, toggleBtn, shortcutInput };
  }

  function updatePanelForFocus(element) {
    if (!element) return;
    const label = getFieldLabel(element);
    ui.target.textContent = `Focused: ${label}`;
  }

  function getFieldLabel(element) {
    if (element instanceof HTMLTextAreaElement) return "Textarea";
    if (element instanceof HTMLInputElement) {
      const inputType = (element.type || "text").toLowerCase();
      if (inputType === "search") return "Search field";
      return `Input (${inputType})`;
    }
    if (element.isContentEditable) return "Editable area";
    return "Editable field";
  }

  function showPanel() {
    ui.panel.classList.add("vtp-visible");
  }

  function hidePanel() {
    ui.panel.classList.remove("vtp-visible");
  }

  function setStatus(text) {
    ui.status.textContent = text;
  }

  function setLoading(active, message) {
    if (!ui.statusSpinner) return;
    if (active) {
      ui.panel.classList.add("vtp-panel--loading");
      ui.panel.setAttribute("aria-busy", "true");
      ui.statusSpinner.classList.add("vtp-spinner--visible");
      if (message) {
        ui.status.textContent = message;
      }
    } else {
      ui.panel.classList.remove("vtp-panel--loading");
      ui.panel.removeAttribute("aria-busy");
      ui.statusSpinner.classList.remove("vtp-spinner--visible");
    }
  }

  function saveEraseCodewordFromPanel(value) {
    const nextCodeword = (value || "").trim().toLowerCase();
    if (!nextCodeword) {
      ui.eraseInput.value = state.settings.eraseCodeword || DEFAULT_SETTINGS.eraseCodeword;
      setStatus("Erase key cannot be empty.");
      return;
    }

    state.settings.eraseCodeword = nextCodeword;
    ui.eraseInput.value = nextCodeword;
    chrome.storage.sync.set(
      {
        [STORAGE_KEY]: {
          ...state.settings,
          eraseCodeword: nextCodeword,
        },
      },
      () => {
        if (chrome.runtime.lastError) {
          setStatus(`Save failed: ${chrome.runtime.lastError.message}`);
          return;
        }
        setStatus(`Erase key set: ${nextCodeword}`);
      }
    );
  }

  function captureShortcutFromPanel(event, inputEl) {
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    const shortcut = eventToShortcut(event);
    if (!shortcut) return;
    state.settings.panelShortcut = shortcut;
    inputEl.value = shortcut;
    chrome.storage.sync.set(
      {
        [STORAGE_KEY]: {
          ...state.settings,
          panelShortcut: shortcut,
        },
      },
      () => {
        if (chrome.runtime.lastError) {
          setStatus(`Shortcut save failed: ${chrome.runtime.lastError.message}`);
          return;
        }
        setStatus(`Shortcut set: ${shortcut}`);
      }
    );
  }

  function eventToShortcut(event) {
    const parts = [];
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("Meta");
    const key = normalizeShortcutKey(event.key);
    if (!key || ["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
    parts.push(key);
    if (parts.length < 2) return null;
    return parts.join("+");
  }

  function normalizeShortcutKey(key) {
    if (!key) return "";
    if (key.length === 1) return key.toUpperCase();
    if (key === " ") return "Space";
    return key[0].toUpperCase() + key.slice(1);
  }

  function matchesShortcut(event, shortcut) {
    const parsed = parseShortcut(shortcut);
    if (!parsed.key) return false;
    if (Boolean(event.ctrlKey) !== parsed.ctrl) return false;
    if (Boolean(event.altKey) !== parsed.alt) return false;
    if (Boolean(event.shiftKey) !== parsed.shift) return false;
    if (Boolean(event.metaKey) !== parsed.meta) return false;
    return normalizeShortcutKey(event.key) === parsed.key;
  }

  function parseShortcut(shortcut) {
    const parts = String(shortcut || "")
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean);
    const parsed = { ctrl: false, alt: false, shift: false, meta: false, key: "" };
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === "ctrl" || lower === "control") parsed.ctrl = true;
      else if (lower === "alt") parsed.alt = true;
      else if (lower === "shift") parsed.shift = true;
      else if (lower === "meta" || lower === "cmd" || lower === "command") parsed.meta = true;
      else parsed.key = normalizeShortcutKey(part);
    }
    return parsed;
  }

  function enableDrag(panel, dragHandle) {
    const onPointerMove = (event) => {
      if (!state.drag.active) return;
      const nextLeft = Math.max(0, event.clientX - state.drag.offsetX);
      const nextTop = Math.max(0, event.clientY - state.drag.offsetY);
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    };

    const stopDragging = () => {
      state.drag.active = false;
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", stopDragging);
    };

    dragHandle.addEventListener("pointerdown", (event) => {
      state.drag.active = true;
      const rect = panel.getBoundingClientRect();
      state.drag.offsetX = event.clientX - rect.left;
      state.drag.offsetY = event.clientY - rect.top;
      panel.setPointerCapture(event.pointerId);
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", stopDragging);
    });
  }

  function setRecordingUI(recording) {
    if (recording) {
      ui.mode.textContent = "Listening... auto-stop on silence";
      ui.toggleBtn.textContent = "Stop";
      ui.panel.classList.add("is-recording");
    } else {
      ui.mode.textContent = "Shortcut: open · toggle dictation when open";
      ui.toggleBtn.textContent = "Start";
      ui.panel.classList.remove("is-recording");
    }
  }

  function isEditableElement(element) {
    if (
      !element ||
      (!(element instanceof HTMLInputElement) &&
        !(element instanceof HTMLTextAreaElement) &&
        !element.isContentEditable)
    ) {
      return false;
    }
    if (element instanceof HTMLInputElement) {
      const textLike = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
      const type = (element.type || "text").toLowerCase();
      if (!textLike.has(type)) return false;
    }
    return !element.disabled && !element.readOnly;
  }

  function insertTextAtCursor(element, text) {
    if (!element || !text) return;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? start;
      element.setRangeText(text, start, end, "end");
      // Some controlled inputs only react when value setter is used.
      syncInputValueForFrameworks(element);
      dispatchInputEvents(element);
      return;
    }

    if (element.isContentEditable) {
      element.focus();
      const selection = window.getSelection();
      if (!selection) return;
      if (!selection.rangeCount) {
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      dispatchInputEvents(element);
    }
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        inputType: "insertText",
      })
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function syncInputValueForFrameworks(element) {
    const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value");
    if (!descriptor?.set) return;
    descriptor.set.call(element, element.value);
  }

  function sendRuntimeMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        payload,
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        }
      );
    });
  }

  function selectStreamingModel(language) {
    const _code = String(language || "en_us").toLowerCase();
    return "u3-rt-pro";
  }

  function handleStreamingMessage(rawData) {
    try {
      const message = JSON.parse(rawData);
      if (message.type !== "Turn") return;

      const turnOrder = Number(message.turn_order);
      const transcript = String(message.transcript || "").trim();
      if (!Number.isFinite(turnOrder)) return;

      state.turnCache[turnOrder] = transcript;
      if (!transcript) return;
      state.pendingTranscript = getOrderedTranscriptText(state.turnCache);
      const parsed = applyEraseCodewordCommands(state.pendingTranscript, state.settings.eraseCodeword);
      renderLivePreview(parsed.text, parsed.backspaces);
      setStatus(`Heard: ${parsed.text}`);
      resetSilenceAutoStop();
    } catch (_error) {
      // ignore non-JSON ping/keepalive payloads
    }
  }

  function getOrderedTranscriptText(turnCache) {
    return Object.keys(turnCache)
      .map((key) => Number(key))
      .filter((num) => Number.isFinite(num))
      .sort((a, b) => a - b)
      .map((order) => turnCache[order] || "")
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function applyEraseCodewordCommands(text, codeword) {
    const normalizedCodeword = String(codeword || "").trim().toLowerCase();
    if (!normalizedCodeword) {
      return { text: text.trim(), backspaces: 0 };
    }

    const tokens = String(text || "").trim().split(/\s+/).filter(Boolean);
    const outputChars = [];
    let pendingBackspaces = 0;

    for (const token of tokens) {
      const normalizedToken = token
        .toLowerCase()
        .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");

      if (normalizedToken === normalizedCodeword) {
        if (outputChars.length > 0) {
          outputChars.pop();
        } else {
          pendingBackspaces += 1;
        }
        continue;
      }

      if (outputChars.length > 0) outputChars.push(" ");
      for (const char of token) outputChars.push(char);
    }

    return {
      text: outputChars.join("").trim(),
      backspaces: pendingBackspaces,
    };
  }

  function createLivePreview(element) {
    if (!element) return null;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? start;
      return {
        type: "input",
        element,
        baseValue: element.value,
        baseStart: start,
        baseEnd: end,
      };
    }

    if (element.isContentEditable) {
      element.focus();
      const selection = window.getSelection();
      if (!selection) return null;
      if (!selection.rangeCount) {
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const range = selection.getRangeAt(0);
      const marker = document.createElement("span");
      marker.setAttribute("data-vtp-live-preview", "true");
      range.insertNode(marker);
      range.setStartAfter(marker);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return { type: "contenteditable", element, marker };
    }

    return null;
  }

  function renderLivePreview(text, externalBackspaces = 0) {
    const preview = state.livePreview;
    if (!preview) return;
    if (preview.type === "input") {
      const { element, baseValue, baseStart, baseEnd } = preview;
      if (!element || !document.contains(element)) return;
      const safeBackspaces = Math.max(0, Math.floor(externalBackspaces));
      const prefixEnd = Math.max(0, baseStart - safeBackspaces);
      const nextValue = `${baseValue.slice(0, prefixEnd)}${text}${baseValue.slice(baseEnd)}`;
      element.focus();
      setInputValue(element, nextValue);
      const caretPos = prefixEnd + text.length;
      element.setSelectionRange(caretPos, caretPos);
      syncInputValueForFrameworks(element);
      dispatchInputEvents(element);
      return;
    }

    if (preview.type === "contenteditable") {
      const { marker, element } = preview;
      if (!marker || !marker.isConnected) return;
      marker.textContent = text;
      dispatchInputEvents(element);
    }
  }

  function finalizeLivePreview(finalText, externalBackspaces = 0) {
    const preview = state.livePreview;
    if (!preview) {
      insertTextAtCursor(state.recordTarget || state.focusedEditable, `${finalText} `);
      return;
    }

    const finalized = finalText ? `${finalText} ` : "";
    if (preview.type === "input") {
      const { element, baseValue, baseStart, baseEnd } = preview;
      if (!element || !document.contains(element)) return;
      const safeBackspaces = Math.max(0, Math.floor(externalBackspaces));
      const prefixEnd = Math.max(0, baseStart - safeBackspaces);
      const nextValue = `${baseValue.slice(0, prefixEnd)}${finalized}${baseValue.slice(baseEnd)}`;
      element.focus();
      setInputValue(element, nextValue);
      const caretPos = prefixEnd + finalized.length;
      element.setSelectionRange(caretPos, caretPos);
      syncInputValueForFrameworks(element);
      dispatchInputEvents(element);
      return;
    }

    if (preview.type === "contenteditable") {
      const { marker, element } = preview;
      if (!marker || !marker.isConnected) return;
      const node = document.createTextNode(finalized);
      marker.replaceWith(node);
      dispatchInputEvents(element);
    }
  }

  function clearLivePreviewText() {
    const preview = state.livePreview;
    if (!preview) return;
    if (preview.type === "input") {
      const { element, baseValue, baseStart } = preview;
      if (!element || !document.contains(element)) return;
      element.focus();
      setInputValue(element, baseValue);
      element.setSelectionRange(baseStart, baseStart);
      syncInputValueForFrameworks(element);
      dispatchInputEvents(element);
      return;
    }

    if (preview.type === "contenteditable") {
      const { marker, element } = preview;
      if (!marker || !marker.isConnected) return;
      marker.remove();
      dispatchInputEvents(element);
    }
  }

  function setInputValue(element, value) {
    const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function resetSilenceAutoStop() {
    clearSilenceTimer();
    state.silenceTimer = window.setTimeout(() => {
      if (state.isRecording) {
        stopLiveStreaming(false);
      }
    }, SILENCE_AUTO_STOP_MS);
  }

  function clearSilenceTimer() {
    if (!state.silenceTimer) return;
    window.clearTimeout(state.silenceTimer);
    state.silenceTimer = null;
  }

  function convertFloat32ToInt16(float32Array, inputSampleRate, outputSampleRate) {
    if (inputSampleRate === outputSampleRate) {
      const buffer = new ArrayBuffer(float32Array.length * 2);
      const view = new DataView(buffer);
      for (let i = 0; i < float32Array.length; i += 1) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return new Uint8Array(buffer);
    }

    const ratio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(float32Array.length / ratio);
    const buffer = new ArrayBuffer(newLength * 2);
    const view = new DataView(buffer);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < newLength) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < float32Array.length; i += 1) {
        accum += float32Array[i];
        count += 1;
      }
      const sample = count > 0 ? accum / count : 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offsetResult * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offsetResult += 1;
      offsetBuffer = nextOffsetBuffer;
    }
    return new Uint8Array(buffer);
  }
})();

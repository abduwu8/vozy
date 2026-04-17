const TOGGLE_MESSAGE = { type: "VOICE_TO_PROMPT_TOGGLE" };
const SETTINGS_KEY = "voiceToPromptSettings";
const DEFAULT_SETTINGS = {
  language: "en_us",
  assemblyApiKey: "8ee31ce8f463406b8a57028ba2e7014e",
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "VOICE_TO_PROMPT_TRANSCRIBE") {
    transcribeAudio(message.payload)
      .then((transcript) => sendResponse({ ok: true, transcript }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Transcription failed." }));
    return true;
  }
  if (message?.type === "VOICE_TO_PROMPT_GET_STREAM_TOKEN") {
    createStreamingToken()
      .then((token) => sendResponse({ ok: true, token }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Token creation failed." }));
    return true;
  }
  return undefined;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-dictation") return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, TOGGLE_MESSAGE);
  } catch (error) {
    // If content script is unavailable for this page, try injecting it on demand.
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["ui.css"],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content_script.js"],
      });
      await chrome.tabs.sendMessage(tab.id, TOGGLE_MESSAGE);
    } catch (injectionError) {
      console.warn("Voice To Prompt could not initialize on this tab.", injectionError);
    }
  }
});

async function transcribeAudio(payload) {
  const { audioBase64, language } = payload || {};
  if (!audioBase64) {
    throw new Error("Missing audio payload.");
  }

  const settings = await chrome.storage.sync.get([SETTINGS_KEY]);
  const mergedSettings = { ...DEFAULT_SETTINGS, ...(settings?.[SETTINGS_KEY] || {}) };
  const apiKey = mergedSettings.assemblyApiKey;
  if (!apiKey) {
    throw new Error("AssemblyAI API key is missing. Add it in extension settings.");
  }

  const audioBuffer = base64ToArrayBuffer(audioBase64);
  const uploadUrl = await uploadAudioToAssembly(apiKey, audioBuffer);
  const transcriptId = await createAssemblyTranscript(apiKey, uploadUrl, language || mergedSettings.language);
  return pollTranscriptUntilComplete(apiKey, transcriptId);
}

async function createStreamingToken() {
  const settings = await chrome.storage.sync.get([SETTINGS_KEY]);
  const mergedSettings = { ...DEFAULT_SETTINGS, ...(settings?.[SETTINGS_KEY] || {}) };
  const apiKey = mergedSettings.assemblyApiKey;
  if (!apiKey) {
    throw new Error("AssemblyAI API key is missing. Add it in extension settings.");
  }

  const response = await fetch("https://streaming.assemblyai.com/v3/token?expires_in_seconds=600", {
    method: "GET",
    headers: {
      authorization: apiKey,
    },
  });

  if (!response.ok) {
    const body = await safeJson(response);
    throw new Error(body?.error || "Failed to create AssemblyAI streaming token.");
  }

  const data = await response.json();
  return data.token;
}

async function uploadAudioToAssembly(apiKey, audioBuffer) {
  const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "content-type": "application/octet-stream",
    },
    body: audioBuffer,
  });

  if (!uploadResponse.ok) {
    const body = await safeJson(uploadResponse);
    throw new Error(body?.error || "AssemblyAI upload failed.");
  }
  const uploadData = await uploadResponse.json();
  return uploadData.upload_url;
}

async function createAssemblyTranscript(apiKey, audioUrl, language) {
  const languageCode = normalizeLanguageCode(language);
  const response = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      language_code: languageCode,
      speech_model: "universal-2",
      speech_models: ["universal-2"],
      punctuate: true,
      format_text: true,
    }),
  });

  if (!response.ok) {
    const body = await safeJson(response);
    throw new Error(body?.error || "AssemblyAI transcript creation failed.");
  }
  const data = await response.json();
  return data.id;
}

function normalizeLanguageCode(language) {
  const allowed = new Set(["en_us", "en_uk", "es", "fr", "de", "it", "pt", "hi", "ja", "ko", "zh"]);
  const cleaned = String(language || "en_us").toLowerCase().replace("-", "_");
  if (allowed.has(cleaned)) return cleaned;
  if (cleaned === "en") return "en_us";
  return "en_us";
}

async function pollTranscriptUntilComplete(apiKey, transcriptId) {
  for (let i = 0; i < 120; i += 1) {
    const response = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      headers: { authorization: apiKey },
    });
    if (!response.ok) {
      const body = await safeJson(response);
      throw new Error(body?.error || "AssemblyAI status check failed.");
    }
    const data = await response.json();
    if (data.status === "completed") {
      return data.text || "";
    }
    if (data.status === "error") {
      throw new Error(data.error || "AssemblyAI transcription error.");
    }
    await sleep(1500);
  }
  throw new Error("Transcription timed out.");
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

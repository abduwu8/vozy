const STORAGE_KEY = "voiceToPromptSettings";
const DEFAULT_SETTINGS = {
  language: "en_us",
  assemblyApiKey: "8ee31ce8f463406b8a57028ba2e7014e",
  eraseCodeword: "apple",
};

const languageEl = document.getElementById("language");
const apiKeyEl = document.getElementById("assemblyApiKey");
const eraseCodewordEl = document.getElementById("eraseCodeword");
const statusEl = document.getElementById("status");

init();

function init() {
  chrome.storage.sync.get([STORAGE_KEY], (result) => {
    const settings = { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEY] || {}) };
    languageEl.value = settings.language;
    apiKeyEl.value = settings.assemblyApiKey || "";
    eraseCodewordEl.value = settings.eraseCodeword || DEFAULT_SETTINGS.eraseCodeword;
    // Ensure defaults exist in storage so background worker reads them immediately.
    chrome.storage.sync.set({ [STORAGE_KEY]: settings });
  });

  languageEl.addEventListener("change", saveSettings);
  apiKeyEl.addEventListener("change", saveSettings);
  eraseCodewordEl.addEventListener("change", saveSettings);
}

function saveSettings() {
  const settings = {
    language: languageEl.value,
    assemblyApiKey: apiKeyEl.value.trim(),
    eraseCodeword: (eraseCodewordEl.value || DEFAULT_SETTINGS.eraseCodeword).trim().toLowerCase(),
  };
  chrome.storage.sync.set({ [STORAGE_KEY]: settings }, () => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = `Error: ${chrome.runtime.lastError.message}`;
      return;
    }
    statusEl.textContent = "Saved.";
    window.setTimeout(() => {
      statusEl.textContent = "";
    }, 1200);
  });
}

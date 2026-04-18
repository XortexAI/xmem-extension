/**
 * XMem popup — settings & connection status.
 * Uses the xmem-ai SDK via the shared api module.
 */

import { checkHealth, getConfig, getHealthStatus, saveConfig } from './api';

document.addEventListener('DOMContentLoaded', async () => {
  const apiUrlInput = document.getElementById('apiUrl') as HTMLInputElement;
  const usernameInput = document.getElementById('username') as HTMLInputElement;
  const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
  const userIdInput = document.getElementById('userId') as HTMLInputElement;
  const enableToggle = document.getElementById('enableToggle') as HTMLInputElement;
  const liveToggle = document.getElementById('liveToggle') as HTMLInputElement;
  const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
  const testBtn = document.getElementById('testBtn') as HTMLButtonElement;
  const saveMsg = document.getElementById('saveMsg') as HTMLDivElement;
  const statusDot = document.getElementById('statusDot') as HTMLDivElement;
  const statusText = document.getElementById('statusText') as HTMLSpanElement;

  const config = await getConfig();
  apiUrlInput.value = config.apiUrl;
  usernameInput.value = config.username;
  apiKeyInput.value = config.apiKey;
  userIdInput.value = config.userId;

  function credentialError(): string | null {
    if (!usernameInput.value.trim()) return 'Username is required.';
    if (!apiKeyInput.value.trim()) return 'API key is required.';
    return null;
  }

  chrome.storage.sync.get(['xmem_enabled', 'xmem_live_suggest'], (data) => {
    enableToggle.checked = data.xmem_enabled !== false;
    liveToggle.checked = data.xmem_live_suggest !== false;
  });

  async function updateStatus() {
    const cfg = await getConfig();
    if (!cfg.username.trim() || !cfg.apiKey.trim()) {
      statusDot.className = 'status-dot offline';
      statusText.textContent = 'Username and API key required';
      return;
    }

    statusDot.className = 'status-dot checking';
    statusText.textContent = 'Checking connection...';
    try {
      const health = await getHealthStatus();
      if (health.pipelines_ready) {
        statusDot.className = 'status-dot online';
        statusText.textContent = `Connected — XMem v${health.version || '?'}`;
      } else if (health.status === 'unreachable') {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Cannot reach XMem server';
      } else {
        statusDot.className = 'status-dot checking';
        statusText.textContent = 'Server up, pipelines loading...';
      }
    } catch (err) {
      statusDot.className = 'status-dot offline';
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('username and API key')) {
        statusText.textContent = 'Username and API key required';
      } else {
        statusText.textContent = 'Cannot reach XMem server';
      }
    }
  }

  await updateStatus();

  saveBtn.addEventListener('click', async () => {
    const errMsg = credentialError();
    if (errMsg) {
      saveMsg.textContent = errMsg;
      saveMsg.className = 'save-msg error';
      setTimeout(() => { saveMsg.className = 'save-msg'; }, 4000);
      return;
    }

    await saveConfig({
      apiUrl: apiUrlInput.value.replace(/\/+$/, ''),
      username: usernameInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      userId: userIdInput.value || 'chrome-extension-user',
    });
    chrome.storage.sync.set({
      xmem_enabled: enableToggle.checked,
      xmem_live_suggest: liveToggle.checked,
    });

    saveMsg.textContent = 'Settings saved!';
    saveMsg.className = 'save-msg success';
    setTimeout(() => { saveMsg.className = 'save-msg'; }, 3000);

    await updateStatus();
  });

  testBtn.addEventListener('click', async () => {
    const errMsg = credentialError();
    if (errMsg) {
      saveMsg.textContent = errMsg;
      saveMsg.className = 'save-msg error';
      setTimeout(() => { saveMsg.className = 'save-msg'; }, 4000);
      return;
    }

    await saveConfig({
      apiUrl: apiUrlInput.value.replace(/\/+$/, ''),
      username: usernameInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      userId: userIdInput.value || 'chrome-extension-user',
    });

    const ok = await checkHealth();
    if (ok) {
      saveMsg.textContent = 'Connection successful — pipelines ready!';
      saveMsg.className = 'save-msg success';
    } else {
      saveMsg.textContent = 'Cannot connect. Check URL, username, and API key.';
      saveMsg.className = 'save-msg error';
    }
    setTimeout(() => { saveMsg.className = 'save-msg'; }, 4000);
    await updateStatus();
  });
});

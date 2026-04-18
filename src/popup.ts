/**
 * XMem popup — welcome / login / settings flow.
 * Uses the xmem-ai SDK via the shared api module.
 *
 * Flow:
 *   1. Welcome page (if not yet configured)
 *   2. Login page (enter API key + username)
 *   3. Settings page (connected — toggle features, logout)
 */

import { checkHealth, getConfig, getHealthStatus, saveConfig, validateCredentials } from './api';

document.addEventListener('DOMContentLoaded', async () => {
  // ── DOM refs ──────────────────────────────────────────────────────
  const pageWelcome = document.getElementById('page-welcome')!;
  const pageLogin = document.getElementById('page-login')!;
  const pageSettings = document.getElementById('page-settings')!;

  const btnHasKey = document.getElementById('btn-has-key') as HTMLButtonElement;
  const btnBack = document.getElementById('btn-back') as HTMLButtonElement;

  const usernameInput = document.getElementById('username') as HTMLInputElement;
  const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
  const enableToggle = document.getElementById('enableToggle') as HTMLInputElement;
  const liveToggle = document.getElementById('liveToggle') as HTMLInputElement;
  const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
  const testBtn = document.getElementById('testBtn') as HTMLButtonElement;
  const msgBar = document.getElementById('msgBar') as HTMLDivElement;

  const displayUsername = document.getElementById('display-username') as HTMLSpanElement;
  const displayKey = document.getElementById('display-key') as HTMLSpanElement;
  const enableToggle2 = document.getElementById('enableToggle2') as HTMLInputElement;
  const liveToggle2 = document.getElementById('liveToggle2') as HTMLInputElement;
  const msgBar2 = document.getElementById('msgBar2') as HTMLDivElement;
  const logoutBtn = document.getElementById('logoutBtn') as HTMLButtonElement;
  const statusDot = document.getElementById('statusDot') as HTMLDivElement;
  const statusText = document.getElementById('statusText') as HTMLSpanElement;

  // ── Page navigation ───────────────────────────────────────────────
  function showPage(page: HTMLElement) {
    [pageWelcome, pageLogin, pageSettings].forEach(p => p.classList.remove('active'));
    page.classList.add('active');
  }

  function showMsg(bar: HTMLDivElement, text: string, type: 'success' | 'error') {
    bar.textContent = text;
    bar.className = `msg-bar ${type}`;
    setTimeout(() => { bar.className = 'msg-bar'; }, 4000);
  }

  // ── Check existing config ─────────────────────────────────────────
  const config = await getConfig();

  if (config.apiKey && config.userId) {
    // Already configured — go to settings page
    showSettingsPage(config.apiKey, config.userId);
  } else {
    showPage(pageWelcome);
  }

  // ── Welcome page events ───────────────────────────────────────────
  btnHasKey.addEventListener('click', () => {
    showPage(pageLogin);
    // Pre-fill if we have partial config
    if (config.apiKey) apiKeyInput.value = config.apiKey;
    if (config.userId && config.userId !== 'chrome-extension-user') {
      usernameInput.value = config.userId;
    }
  });

  btnBack.addEventListener('click', () => {
    showPage(pageWelcome);
  });

  // ── Load toggle states ────────────────────────────────────────────
  chrome.storage.sync.get(['xmem_enabled', 'xmem_live_suggest'], (data) => {
    const enabled = data.xmem_enabled !== false;
    const live = data.xmem_live_suggest !== false;
    enableToggle.checked = enabled;
    liveToggle.checked = live;
    enableToggle2.checked = enabled;
    liveToggle2.checked = live;
  });

  // ── Test button ───────────────────────────────────────────────────
  testBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    const user = usernameInput.value.trim();

    if (!key || !user) {
      showMsg(msgBar, 'Please enter both username and API key.', 'error');
      return;
    }

    testBtn.textContent = '...';
    testBtn.disabled = true;

    // NOTE: Do NOT save to chrome.storage here — test only, don't persist
    try {
      const isValid = await validateCredentials(key, user);
      if (isValid) {
        showMsg(msgBar, '✓ Credentials verified! Click Save to continue.', 'success');
      } else {
        showMsg(msgBar, 'Invalid API Key or Username mismatch.', 'error');
      }
    } catch {
      showMsg(msgBar, 'Connection failed. Check your data.', 'error');
    }

    testBtn.textContent = 'Test';
    testBtn.disabled = false;
  });

  // ── Save button ───────────────────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    const user = usernameInput.value.trim();

    if (!key || !user) {
      showMsg(msgBar, 'Please enter both username and API key.', 'error');
      return;
    }

    saveBtn.textContent = 'Verifying...';
    saveBtn.disabled = true;

    // Validate FIRST — only persist if credentials are valid
    try {
      const isValid = await validateCredentials(key, user);
      if (!isValid) {
        showMsg(msgBar, 'Invalid API Key or Username mismatch.', 'error');
        saveBtn.textContent = 'Save Settings';
        saveBtn.disabled = false;
        return; // Don't save anything
      }

      // Credentials valid → now persist to chrome.storage
      await saveConfig({ apiKey: key, userId: user });
      chrome.storage.sync.set({
        xmem_enabled: enableToggle.checked,
        xmem_live_suggest: liveToggle.checked,
      });

      showMsg(msgBar, '✓ Settings saved & connected!', 'success');
      setTimeout(() => showSettingsPage(key, user), 800);
    } catch {
      showMsg(msgBar, 'Network error. Try again.', 'error');
      saveBtn.textContent = 'Save Settings';
      saveBtn.disabled = false;
      return;
    }

    saveBtn.textContent = 'Save Settings';
    saveBtn.disabled = false;
  });

  // ── Settings page ─────────────────────────────────────────────────
  function showSettingsPage(key: string, username: string) {
    showPage(pageSettings);
    displayUsername.textContent = username;
    displayKey.textContent = key.length > 12
      ? `${key.slice(0, 8)}…${key.slice(-4)}`
      : '••••••••';

    updateConnectionStatus();
  }

  async function updateConnectionStatus() {
    statusDot.className = 'status-dot checking';
    statusText.textContent = 'Checking...';

    try {
      const health = await getHealthStatus();
      if (health.pipelines_ready) {
        statusDot.className = 'status-dot online';
        statusText.textContent = `Connected v${health.version || '?'}`;
      } else if (health.status === 'unreachable') {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Unreachable';
      } else {
        statusDot.className = 'status-dot checking';
        statusText.textContent = 'Loading...';
      }
    } catch {
      statusDot.className = 'status-dot offline';
      statusText.textContent = 'Unreachable';
    }
  }

  // Toggle sync from settings page
  enableToggle2.addEventListener('change', () => {
    chrome.storage.sync.set({ xmem_enabled: enableToggle2.checked });
  });
  liveToggle2.addEventListener('change', () => {
    chrome.storage.sync.set({ xmem_live_suggest: liveToggle2.checked });
  });

  // ── Logout ────────────────────────────────────────────────────────
  logoutBtn.addEventListener('click', async () => {
    await saveConfig({ apiKey: '', userId: '' });
    chrome.storage.sync.remove([
      'xmem_api_key', 'xmem_user_id', 'xmem_mode',
      'xmem_ide_org_id', 'xmem_ide_repo',
    ]);
    showPage(pageWelcome);
  });
});

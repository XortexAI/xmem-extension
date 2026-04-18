/**
 * XMem background service worker.
 * Handles context menus, extension lifecycle, and message routing.
 */

import * as XMemSDK from 'xmem-ai';

interface XMemConfig {
  apiUrl: string;
  apiKey: string;
  username: string;
  userId: string;
}

let _cachedClient: XMemSDK.XMemClient | null = null;
let _cachedConfigKey = '';

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') {
      if (
        changes.xmem_api_url ||
        changes.xmem_api_key ||
        changes.xmem_username ||
        changes.xmem_user_id
      ) {
        _cachedClient = null;
        _cachedConfigKey = '';
      }
    }
  });
}

async function getConfig(): Promise<XMemConfig> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ['xmem_api_url', 'xmem_api_key', 'xmem_username', 'xmem_user_id'],
      (data) => {
        resolve({
          apiUrl: data.xmem_api_url || 'http://localhost:8000',
          apiKey: data.xmem_api_key || '',
          username:
            data.xmem_username ||
            data.xmem_user_id ||
            'chrome-extension-user',
          userId: data.xmem_user_id || 'chrome-extension-user',
        });
      },
    );
  });
}

async function getClient(): Promise<{ client: XMemSDK.XMemClient; userId: string }> {
  const config = await getConfig();
  const apiKey = config.apiKey.trim();
  const username = config.username.trim();
  if (!apiKey || !username) {
    throw new Error(
      'XMem username and API key are required. Configure them in the extension popup.',
    );
  }

  const configKey = `${config.apiUrl}|${apiKey}|${username}`;
  if (!_cachedClient || configKey !== _cachedConfigKey) {
    _cachedClient = new XMemSDK.XMemClient(config.apiUrl, apiKey, username);
    _cachedConfigKey = configKey;
  }
  return { client: _cachedClient, userId: config.userId };
}

// ─── Extension Lifecycle ──────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(['xmem_enabled'], (data) => {
    if (data.xmem_enabled === undefined) {
      chrome.storage.sync.set({ xmem_enabled: true });
    }
  });

  chrome.contextMenus.create({
    id: 'xmem-save-selection',
    title: 'Save to XMem Memory',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'xmem-save-selection' && info.selectionText) {
    try {
      const { client, userId } = await getClient();
      await client.ingest({
        user_query: `Remember this: ${info.selectionText}`,
        user_id: userId,
      });
    } catch (err) {
      console.error('XMem: Failed to save selection', err);
    }
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'xmem_open_tab' && request.url) {
    chrome.tabs.create({ url: request.url });
    return false;
  }

  if (request.action === 'xmem_toggle_sidebar') {
    const tabId = sender.tab?.id;
    if (tabId !== null && tabId !== undefined) {
      chrome.tabs.sendMessage(tabId, { action: 'xmem_toggle_sidebar' });
    }
    return false;
  }

  return false;
});

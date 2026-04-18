/**
 * XMem background service worker.
 * Handles context menus, extension lifecycle, and message routing.
 */

import { XMemClient } from 'xmem-ai';

/** Hardcoded API endpoint — never exposed to end users. */
const API_BASE_URL = 'https://api.xmem.in';

interface XMemConfig {
  apiKey: string;
  userId: string;
}

let _cachedClient: XMemClient | null = null;
let _cachedConfigKey = '';

async function getConfig(): Promise<XMemConfig> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['xmem_api_key', 'xmem_user_id'], (data) => {
      resolve({
        apiKey: data.xmem_api_key || '',
        userId: data.xmem_user_id || '',
      });
    });
  });
}

async function getClient(): Promise<{ client: XMemClient; userId: string }> {
  const config = await getConfig();
  const configKey = `${config.apiKey}|${config.userId}`;
  if (!_cachedClient || configKey !== _cachedConfigKey) {
    _cachedClient = new XMemClient(API_BASE_URL, config.apiKey, config.userId);
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

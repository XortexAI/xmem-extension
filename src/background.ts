/**
 * XMem background service worker.
 * Handles context menus, message routing, and extension lifecycle.
 * Uses the xmem-ai SDK via the shared api module.
 */

import { ingestMemory } from './api';

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
      await ingestMemory(`Remember this: ${info.selectionText}`);
    } catch (err) {
      console.error('XMem: Failed to save selection', err);
    }
  }
});

chrome.runtime.onMessage.addListener((request, sender) => {
  if (request.action === 'xmem_open_tab' && request.url) {
    chrome.tabs.create({ url: request.url });
  }
  if (request.action === 'xmem_toggle_sidebar') {
    const tabId = sender.tab?.id;
    if (tabId !== null && tabId !== undefined) {
      chrome.tabs.sendMessage(tabId, { action: 'xmem_toggle_sidebar' });
    }
  }
  return undefined;
});

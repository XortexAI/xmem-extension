/**
 * XMem Content Script — the brain of the extension.
 *
 * Responsibilities:
 *  1. Detects editable fields on AI chat UIs (ChatGPT, Claude, Gemini, etc.)
 *  2. As the user types, debounces + searches XMem for relevant memories
 *  3. Renders an inline floating chip showing memory count near the input
 *  4. On click (or Ctrl+Shift+M), opens a full sidebar with memory details
 *  5. Auto-saves conversations by hooking send buttons / Enter key
 */

import { searchMemories, ingestMemory, retrieveAnswer, type SourceRecord } from './api';

// ─── Globals ──────────────────────────────────────────────────────────────

let sidebarOpen = false;
let sidebarEl: HTMLElement | null = null;
let chipEl: HTMLElement | null = null;
let lastSearchResults: SourceRecord[] = [];
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let currentAbortController: { cancelled: boolean } | null = null;
let lastSearchedText = '';
let lastInputText = '';

const DEBOUNCE_MS = 400;
const MIN_QUERY_LEN = 8;

// ─── Editor Detection ─────────────────────────────────────────────────────

const EDITOR_SELECTORS = [
  '#prompt-textarea',                            // ChatGPT
  'div.ProseMirror[contenteditable="true"]',     // Claude
  'div[contenteditable="true"]',                 // General
  'textarea[placeholder]',                       // Gemini, Perplexity
  'rich-textarea textarea',                      // DeepSeek
  'textarea',                                    // Fallback
];

function findEditor(): HTMLElement | null {
  for (const sel of EDITOR_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

function getEditorText(editor: HTMLElement): string {
  if (editor instanceof HTMLTextAreaElement) return editor.value;
  return editor.textContent || '';
}

// ─── Floating Memory Chip ─────────────────────────────────────────────────

function ensureChip(anchor: HTMLElement): HTMLElement {
  if (chipEl && document.body.contains(chipEl)) return chipEl;

  chipEl = document.createElement('div');
  chipEl.id = 'xmem-chip';
  chipEl.innerHTML = `
    <div class="xmem-chip-inner">
      <span class="xmem-chip-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a7 7 0 0 1 7 7c0 3-2 5.5-4 7l-3 3.5L9 16c-2-1.5-4-4-4-7a7 7 0 0 1 7-7z"/>
          <circle cx="12" cy="9" r="2.5"/>
        </svg>
      </span>
      <span class="xmem-chip-count">0</span>
      <span class="xmem-chip-label">memories</span>
    </div>
  `;
  document.body.appendChild(chipEl);
  positionChip(anchor);
  chipEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSidebar();
  });

  return chipEl;
}

function positionChip(anchor: HTMLElement) {
  if (!chipEl) return;
  const rect = anchor.getBoundingClientRect();
  chipEl.style.position = 'fixed';
  chipEl.style.top = `${rect.top - 36}px`;
  chipEl.style.left = `${rect.right - 160}px`;
  chipEl.style.zIndex = '2147483646';
}

function updateChip(count: number, loading = false) {
  if (!chipEl) return;
  const countEl = chipEl.querySelector('.xmem-chip-count');
  const labelEl = chipEl.querySelector('.xmem-chip-label');
  const inner = chipEl.querySelector('.xmem-chip-inner') as HTMLElement;

  if (countEl) countEl.textContent = loading ? '...' : String(count);
  if (labelEl) labelEl.textContent = loading ? 'searching' : (count === 1 ? 'memory' : 'memories');
  if (inner) {
    inner.classList.toggle('xmem-chip-active', count > 0 || loading);
    inner.classList.toggle('xmem-chip-loading', loading);
  }
}

function hideChip() {
  if (chipEl) chipEl.style.display = 'none';
}

function showChip() {
  if (chipEl) chipEl.style.display = 'block';
}

// ─── Sidebar ──────────────────────────────────────────────────────────────

function createSidebar(): HTMLElement {
  if (sidebarEl && document.body.contains(sidebarEl)) return sidebarEl;

  sidebarEl = document.createElement('div');
  sidebarEl.id = 'xmem-sidebar';
  sidebarEl.innerHTML = `
    <div class="xmem-sb-header">
      <div class="xmem-sb-logo">
        <div class="xmem-sb-logo-icon">X</div>
        <span>XMem</span>
      </div>
      <div class="xmem-sb-header-actions">
        <button class="xmem-sb-btn" id="xmem-sb-save" title="Save current input as memory">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
            <polyline points="17 21 17 13 7 13 7 21"/>
            <polyline points="7 3 7 8 15 8"/>
          </svg>
        </button>
        <button class="xmem-sb-btn" id="xmem-sb-close" title="Close sidebar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>

    <div class="xmem-sb-tabs">
      <button class="xmem-sb-tab active" data-tab="memories">Memories</button>
      <button class="xmem-sb-tab" data-tab="ask">Ask Memory</button>
      <button class="xmem-sb-tab" data-tab="settings">Settings</button>
    </div>

    <div class="xmem-sb-search-bar">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input type="text" id="xmem-sb-search" placeholder="Search your memories..." />
    </div>

    <div class="xmem-sb-content" id="xmem-sb-content">
      <div class="xmem-sb-panel active" id="xmem-panel-memories"></div>
      <div class="xmem-sb-panel" id="xmem-panel-ask">
        <div class="xmem-ask-container">
          <textarea id="xmem-ask-input" placeholder="Ask a question and XMem will answer from your memories..." rows="3"></textarea>
          <button class="xmem-ask-btn" id="xmem-ask-btn">Ask XMem</button>
          <div id="xmem-ask-result" class="xmem-ask-result"></div>
        </div>
      </div>
      <div class="xmem-sb-panel" id="xmem-panel-settings">
        <div class="xmem-settings-info">
          <p>Configure XMem in the extension popup (click the extension icon).</p>
          <div class="xmem-sb-stats" id="xmem-sb-stats">
            <div class="xmem-stat">
              <span class="xmem-stat-value" id="xmem-stat-results">0</span>
              <span class="xmem-stat-label">Results loaded</span>
            </div>
            <div class="xmem-stat">
              <span class="xmem-stat-value" id="xmem-stat-domains">3</span>
              <span class="xmem-stat-label">Domains active</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="xmem-sb-footer">
      <span>Shortcut: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd></span>
    </div>
  `;

  document.body.appendChild(sidebarEl);
  setupSidebarEvents(sidebarEl);
  return sidebarEl;
}

function setupSidebarEvents(sidebar: HTMLElement) {
  sidebar.querySelector('#xmem-sb-close')?.addEventListener('click', () => toggleSidebar());

  sidebar.querySelectorAll<HTMLElement>('.xmem-sb-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      sidebar.querySelectorAll('.xmem-sb-tab').forEach((t) => t.classList.remove('active'));
      sidebar.querySelectorAll('.xmem-sb-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      const panelId = `xmem-panel-${tab.dataset.tab}`;
      sidebar.querySelector(`#${panelId}`)?.classList.add('active');
    });
  });

  const searchInput = sidebar.querySelector('#xmem-sb-search') as HTMLInputElement;
  searchInput?.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (q.length >= 3) {
      doManualSearch(q);
    } else if (q.length === 0) {
      renderMemories(lastSearchResults);
    }
  });

  sidebar.querySelector('#xmem-sb-save')?.addEventListener('click', async () => {
    const editor = findEditor();
    if (!editor) return;
    const text = getEditorText(editor).trim();
    if (!text) return;
    try {
      await ingestMemory(text);
      showToast('Memory saved!');
    } catch (err) {
      showToast('Failed to save memory', true);
    }
  });

  sidebar.querySelector('#xmem-ask-btn')?.addEventListener('click', async () => {
    const input = sidebar.querySelector('#xmem-ask-input') as HTMLTextAreaElement;
    const resultDiv = sidebar.querySelector('#xmem-ask-result') as HTMLElement;
    const query = input?.value.trim();
    if (!query) return;

    resultDiv.innerHTML = '<div class="xmem-loader"></div>';
    try {
      const resp = await retrieveAnswer(query);
      resultDiv.innerHTML = `
        <div class="xmem-answer">
          <div class="xmem-answer-text">${escapeHtml(resp.answer)}</div>
          ${resp.sources.length > 0 ? `
            <div class="xmem-answer-sources">
              <span class="xmem-answer-sources-label">${resp.sources.length} source${resp.sources.length > 1 ? 's' : ''}</span>
              ${resp.sources.map((s) => `
                <div class="xmem-source-item">
                  <span class="xmem-domain-tag xmem-domain-${s.domain}">${s.domain}</span>
                  <span>${escapeHtml(s.content.substring(0, 100))}</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
    } catch {
      resultDiv.innerHTML = '<div class="xmem-error">Failed to retrieve answer. Check connection.</div>';
    }
  });

  sidebar.addEventListener('click', (e) => e.stopPropagation());
}

function toggleSidebar() {
  const sidebar = createSidebar();
  sidebarOpen = !sidebarOpen;
  sidebar.classList.toggle('xmem-sb-open', sidebarOpen);
  if (sidebarOpen) {
    renderMemories(lastSearchResults);
    document.addEventListener('click', outsideClickHandler);
    document.addEventListener('keydown', escHandler);
  } else {
    document.removeEventListener('click', outsideClickHandler);
    document.removeEventListener('keydown', escHandler);
  }
}

function outsideClickHandler(e: MouseEvent) {
  if (sidebarEl && !sidebarEl.contains(e.target as Node) && chipEl && !chipEl.contains(e.target as Node)) {
    if (sidebarOpen) toggleSidebar();
  }
}

function escHandler(e: KeyboardEvent) {
  if (e.key === 'Escape' && sidebarOpen) toggleSidebar();
}

// ─── Memory Rendering ─────────────────────────────────────────────────────

function renderMemories(memories: SourceRecord[]) {
  const panel = document.getElementById('xmem-panel-memories');
  if (!panel) return;

  const statsEl = document.getElementById('xmem-stat-results');
  if (statsEl) statsEl.textContent = String(memories.length);

  if (memories.length === 0) {
    panel.innerHTML = `
      <div class="xmem-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#52525b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a7 7 0 0 1 7 7c0 3-2 5.5-4 7l-3 3.5L9 16c-2-1.5-4-4-4-7a7 7 0 0 1 7-7z"/>
          <circle cx="12" cy="9" r="2.5"/>
        </svg>
        <p>No memories found</p>
        <span>Start typing in a chat to see relevant memories</span>
      </div>
    `;
    return;
  }

  panel.innerHTML = memories.map((m, i) => `
    <div class="xmem-memory-card" data-idx="${i}">
      <div class="xmem-memory-header">
        <span class="xmem-domain-tag xmem-domain-${m.domain}">${m.domain}</span>
        <span class="xmem-score">${(m.score * 100).toFixed(0)}%</span>
      </div>
      <div class="xmem-memory-text">${escapeHtml(m.content)}</div>
      <div class="xmem-memory-actions">
        <button class="xmem-copy-btn" data-idx="${i}" title="Copy to clipboard">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
          </svg>
        </button>
        <button class="xmem-inject-btn" data-idx="${i}" title="Add to prompt">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add
        </button>
      </div>
    </div>
  `).join('');

  panel.querySelectorAll<HTMLElement>('.xmem-copy-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx || '0', 10);
      const mem = memories[idx];
      if (mem) {
        navigator.clipboard.writeText(mem.content).then(() => {
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
          setTimeout(() => {
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
          }, 1500);
        });
      }
    });
  });

  panel.querySelectorAll<HTMLElement>('.xmem-inject-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx || '0', 10);
      const mem = memories[idx];
      if (mem) injectMemoryIntoEditor(mem);
    });
  });
}

function injectMemoryIntoEditor(memory: SourceRecord) {
  const editor = findEditor();
  if (!editor) return;

  const prefix = `\n\n[XMem ${memory.domain}] ${memory.content}\n`;

  if (editor instanceof HTMLTextAreaElement) {
    editor.value += prefix;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const div = document.createElement('div');
    div.innerHTML = `<br><span style="background:#dbeafe;padding:2px 6px;border-radius:4px;font-size:13px;color:#1e40af;" contenteditable="false">[XMem/${memory.domain}] ${escapeHtml(memory.content)}</span>`;
    editor.appendChild(div);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }
  showToast('Memory added to prompt');
}

// ─── Real-time Search ─────────────────────────────────────────────────────

async function doLiveSearch(text: string) {
  if (text.length < MIN_QUERY_LEN) {
    updateChip(0);
    return;
  }

  if (text === lastSearchedText) return;
  lastSearchedText = text;

  if (currentAbortController) {
    currentAbortController.cancelled = true;
  }
  currentAbortController = { cancelled: false };
  const thisRequest = currentAbortController;

  updateChip(0, true);

  try {
    const results = await searchMemories(text, { topK: 10 });
    if (thisRequest.cancelled) return;

    lastSearchResults = results;
    updateChip(results.length);

    if (sidebarOpen) renderMemories(results);
  } catch {
    if (thisRequest.cancelled) return;
    updateChip(0);
  }
}

async function doManualSearch(query: string) {
  try {
    const results = await searchMemories(query, { topK: 15 });
    lastSearchResults = results;
    renderMemories(results);
  } catch {
    renderMemories([]);
  }
}

// ─── Send Interception (auto-save) ────────────────────────────────────────

function hookSendButton() {
  const sendSelectors = [
    'button[data-testid="send-button"]',           // ChatGPT
    '#composer-submit-button',                      // ChatGPT alt
    'button[aria-label="Send Message"]',            // Claude
    'button[aria-label="Send message"]',            // Gemini
    'button[type="submit"]',                        // Generic
  ];

  for (const sel of sendSelectors) {
    const btn = document.querySelector<HTMLButtonElement>(sel);
    if (btn && !btn.dataset.xmemHooked) {
      btn.dataset.xmemHooked = 'true';
      btn.addEventListener('click', captureAndSave, true);
    }
  }
}

function hookEnterKey(editor: HTMLElement) {
  if (editor.dataset.xmemEnterHooked) return;
  editor.dataset.xmemEnterHooked = 'true';

  editor.addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey) {
      lastInputText = getEditorText(editor);
      setTimeout(captureAndSave, 50);
    }
  });
}

async function captureAndSave() {
  const enabled = await new Promise<boolean>((resolve) => {
    chrome.storage.sync.get(['xmem_enabled'], (data) => resolve(data.xmem_enabled !== false));
  });
  if (!enabled) return;

  const editor = findEditor();
  const text = lastInputText || (editor ? getEditorText(editor) : '');
  if (!text || text.trim().length < 5) return;

  const cleaned = text.replace(/<[^>]+>/g, '').replace(/\[XMem[^\]]*\][^\n]*/g, '').trim();
  if (!cleaned) return;

  try {
    await ingestMemory(cleaned);
  } catch (err) {
    console.error('XMem: auto-save failed', err);
  }

  lastInputText = '';
}

// ─── Toast ────────────────────────────────────────────────────────────────

function showToast(msg: string, isError = false) {
  const existing = document.getElementById('xmem-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'xmem-toast';
  toast.className = isError ? 'xmem-toast-error' : 'xmem-toast-success';
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('xmem-toast-visible'));
  setTimeout(() => {
    toast.classList.remove('xmem-toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ─── Utility ──────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Styles ───────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('xmem-styles')) return;
  const style = document.createElement('style');
  style.id = 'xmem-styles';
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

    /* ─ Chip ─ */
    #xmem-chip {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      position: fixed;
      transition: opacity 0.2s, transform 0.2s;
      pointer-events: auto;
      cursor: pointer;
    }
    .xmem-chip-inner {
      display: flex; align-items: center; gap: 5px;
      padding: 5px 12px; border-radius: 20px;
      background: #1e1e24; border: 1px solid #333;
      color: #71717a; font-size: 12px; font-weight: 500;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      transition: all 0.25s;
      user-select: none;
    }
    .xmem-chip-inner:hover {
      border-color: #7c3aed; color: #c4b5fd;
      box-shadow: 0 2px 16px rgba(124,58,237,0.2);
    }
    .xmem-chip-inner.xmem-chip-active {
      background: linear-gradient(135deg, #1a1a2e, #16213e);
      border-color: #7c3aed; color: #c4b5fd;
    }
    .xmem-chip-inner.xmem-chip-loading {
      border-color: #f59e0b; color: #fbbf24;
    }
    .xmem-chip-icon { display: flex; align-items: center; }
    .xmem-chip-count { font-weight: 700; font-size: 13px; }

    /* ─ Sidebar ─ */
    #xmem-sidebar {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      position: fixed; top: 0; right: -420px; width: 400px; height: 100vh;
      background: #0f0f11; border-left: 1px solid #27272a;
      z-index: 2147483647;
      display: flex; flex-direction: column;
      transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: -4px 0 24px rgba(0,0,0,0.5);
      color: #e4e4e7;
    }
    #xmem-sidebar.xmem-sb-open { right: 0; }

    .xmem-sb-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 14px 16px;
      background: linear-gradient(135deg, #1a1a2e, #16213e);
      border-bottom: 1px solid #27272a;
      flex-shrink: 0;
    }
    .xmem-sb-logo {
      display: flex; align-items: center; gap: 10px;
      font-size: 16px; font-weight: 700; color: #fff;
    }
    .xmem-sb-logo-icon {
      width: 28px; height: 28px;
      background: linear-gradient(135deg, #7c3aed, #3b82f6);
      border-radius: 8px; display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 800; color: white;
    }
    .xmem-sb-header-actions { display: flex; gap: 6px; }
    .xmem-sb-btn {
      background: none; border: 1px solid #333; border-radius: 6px;
      color: #a1a1aa; cursor: pointer; padding: 5px 7px;
      display: flex; align-items: center; transition: all 0.2s;
    }
    .xmem-sb-btn:hover { color: #fff; border-color: #7c3aed; background: #7c3aed20; }

    .xmem-sb-tabs {
      display: flex; border-bottom: 1px solid #27272a;
      flex-shrink: 0;
    }
    .xmem-sb-tab {
      flex: 1; padding: 10px 12px; background: none; border: none;
      color: #71717a; font-size: 12px; font-weight: 600; cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 0.2s, border-color 0.2s;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .xmem-sb-tab:hover { color: #e4e4e7; }
    .xmem-sb-tab.active { color: #c4b5fd; border-bottom-color: #7c3aed; }

    .xmem-sb-search-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 16px; border-bottom: 1px solid #27272a;
      color: #71717a; flex-shrink: 0;
    }
    .xmem-sb-search-bar input {
      flex: 1; background: none; border: none; outline: none;
      color: #e4e4e7; font-size: 13px;
    }
    .xmem-sb-search-bar input::placeholder { color: #52525b; }

    .xmem-sb-content {
      flex: 1; overflow-y: auto;
      scrollbar-width: thin; scrollbar-color: #333 transparent;
    }
    .xmem-sb-content::-webkit-scrollbar { width: 4px; }
    .xmem-sb-content::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }

    .xmem-sb-panel { display: none; padding: 12px 16px; }
    .xmem-sb-panel.active { display: block; }

    /* Memory Cards */
    .xmem-memory-card {
      background: #18181b; border: 1px solid #27272a; border-radius: 10px;
      padding: 12px; margin-bottom: 8px;
      transition: border-color 0.2s, background 0.2s;
    }
    .xmem-memory-card:hover {
      border-color: #333; background: #1e1e24;
    }
    .xmem-memory-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 8px;
    }
    .xmem-domain-tag {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; padding: 2px 8px; border-radius: 4px;
    }
    .xmem-domain-profile { background: #7c3aed20; color: #a78bfa; }
    .xmem-domain-temporal { background: #3b82f620; color: #60a5fa; }
    .xmem-domain-summary { background: #22c55e20; color: #4ade80; }
    .xmem-score { font-size: 11px; color: #71717a; font-weight: 500; }

    .xmem-memory-text {
      font-size: 13px; line-height: 1.5; color: #d4d4d8;
      word-break: break-word;
    }
    .xmem-memory-actions {
      display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end;
    }
    .xmem-copy-btn, .xmem-inject-btn {
      background: #27272a; border: 1px solid #333; border-radius: 6px;
      color: #a1a1aa; cursor: pointer; padding: 4px 8px;
      display: flex; align-items: center; gap: 4px;
      font-size: 11px; font-weight: 500;
      transition: all 0.2s;
    }
    .xmem-copy-btn:hover, .xmem-inject-btn:hover {
      background: #333; color: #fff; border-color: #7c3aed;
    }

    /* Empty state */
    .xmem-empty {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 48px 16px; text-align: center; gap: 10px;
    }
    .xmem-empty p { color: #71717a; font-size: 14px; font-weight: 500; }
    .xmem-empty span { color: #52525b; font-size: 12px; }

    /* Ask panel */
    .xmem-ask-container { display: flex; flex-direction: column; gap: 10px; }
    .xmem-ask-container textarea {
      width: 100%; background: #18181b; border: 1px solid #27272a; border-radius: 8px;
      color: #e4e4e7; padding: 10px 12px; font-size: 13px; resize: vertical;
      font-family: inherit;
    }
    .xmem-ask-container textarea:focus { outline: none; border-color: #7c3aed; }
    .xmem-ask-container textarea::placeholder { color: #52525b; }
    .xmem-ask-btn {
      background: linear-gradient(135deg, #7c3aed, #6d28d9); color: white;
      border: none; border-radius: 8px; padding: 10px 16px;
      font-size: 13px; font-weight: 600; cursor: pointer;
      transition: filter 0.2s;
    }
    .xmem-ask-btn:hover { filter: brightness(1.1); }
    .xmem-ask-result { min-height: 40px; }
    .xmem-answer { padding: 12px; background: #18181b; border: 1px solid #27272a; border-radius: 8px; }
    .xmem-answer-text { font-size: 13px; line-height: 1.6; color: #d4d4d8; }
    .xmem-answer-sources { margin-top: 10px; border-top: 1px solid #27272a; padding-top: 8px; }
    .xmem-answer-sources-label { font-size: 11px; color: #71717a; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .xmem-source-item {
      display: flex; align-items: flex-start; gap: 6px;
      margin-top: 6px; font-size: 12px; color: #a1a1aa;
    }
    .xmem-error { color: #ef4444; font-size: 13px; padding: 10px; }

    /* Settings panel */
    .xmem-settings-info { padding: 12px; }
    .xmem-settings-info p { font-size: 13px; color: #a1a1aa; margin-bottom: 16px; }
    .xmem-sb-stats { display: flex; gap: 12px; }
    .xmem-stat {
      flex: 1; background: #18181b; border: 1px solid #27272a; border-radius: 8px;
      padding: 12px; text-align: center;
    }
    .xmem-stat-value { display: block; font-size: 20px; font-weight: 700; color: #c4b5fd; }
    .xmem-stat-label { font-size: 11px; color: #71717a; }

    .xmem-sb-footer {
      padding: 10px 16px; border-top: 1px solid #27272a;
      font-size: 11px; color: #52525b; text-align: center;
      flex-shrink: 0;
    }
    .xmem-sb-footer kbd {
      background: #27272a; padding: 1px 5px; border-radius: 4px;
      font-family: inherit;
    }

    /* Loader */
    .xmem-loader {
      width: 20px; height: 20px; border: 2px solid #333;
      border-top-color: #7c3aed; border-radius: 50%;
      animation: xmem-spin 0.8s linear infinite;
      margin: 20px auto;
    }
    @keyframes xmem-spin { to { transform: rotate(360deg); } }

    /* Toast */
    #xmem-toast {
      font-family: 'Inter', -apple-system, sans-serif;
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px);
      padding: 10px 20px; border-radius: 8px; font-size: 13px; font-weight: 500;
      z-index: 2147483647; opacity: 0;
      transition: opacity 0.3s, transform 0.3s;
      pointer-events: none;
    }
    #xmem-toast.xmem-toast-visible { opacity: 1; transform: translateX(-50%) translateY(0); }
    .xmem-toast-success { background: #22c55e20; color: #4ade80; border: 1px solid #22c55e40; }
    .xmem-toast-error { background: #ef444420; color: #f87171; border: 1px solid #ef444440; }
  `;
  document.head.appendChild(style);
}

// ─── Main Loop ────────────────────────────────────────────────────────────

let observerActive = false;

function mainLoop() {
  const editor = findEditor();
  if (!editor) return;

  ensureChip(editor);
  positionChip(editor);
  hookSendButton();
  hookEnterKey(editor);

  if (!editor.dataset.xmemInputHooked) {
    editor.dataset.xmemInputHooked = 'true';

    const onInput = () => {
      chrome.storage.sync.get(['xmem_enabled', 'xmem_live_suggest'], (data) => {
        if (data.xmem_enabled === false || data.xmem_live_suggest === false) return;

        const text = getEditorText(editor).trim();
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

        if (text.length >= MIN_QUERY_LEN) {
          showChip();
          searchDebounceTimer = setTimeout(() => doLiveSearch(text), DEBOUNCE_MS);
        } else {
          updateChip(0);
        }
      });
    };

    editor.addEventListener('input', onInput);
    editor.addEventListener('keyup', onInput);

    editor.addEventListener('focus', () => {
      showChip();
      positionChip(editor);
    });
  }
}

function startObserver() {
  if (observerActive) return;
  observerActive = true;

  const mo = new MutationObserver(() => {
    mainLoop();
  });
  mo.observe(document.body, { childList: true, subtree: true });

  mainLoop();
}

// ─── Keyboard Shortcut ────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'M') {
    e.preventDefault();
    toggleSidebar();
  }
});

// Listen for sidebar toggle from background
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'xmem_toggle_sidebar') {
    toggleSidebar();
  }
  return undefined;
});

// ─── Boot ─────────────────────────────────────────────────────────────────

injectStyles();
startObserver();

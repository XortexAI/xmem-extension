/**
 * XMem Content Script — Inline memory autocomplete for AI chat UIs.
 *
 * As you type in ChatGPT / Claude / Gemini / Perplexity, XMem searches
 * your memory and shows ghost-text suggestions inline. Press Tab to
 * accept the suggestion, Escape to dismiss. Ctrl+Shift+M opens the
 * full memory sidebar.
 */

import { retrieveAnswer, searchMemories, ingestMemory, type SourceRecord } from './api';

// ─── Config ───────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 600;
const MIN_QUERY_LEN = 8;
const MAX_GHOST_CHARS = 150;
const MIN_RELEVANCE_SCORE = 0.4;

// ─── State ────────────────────────────────────────────────────────────────

let ghostEl: HTMLElement | null = null;
let ghostAnswer = '';
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inflightReq: { cancelled: boolean } | null = null;
let prevQueryText = '';
let savedInputText = '';

let sidebarOpen = false;
let sidebarEl: HTMLElement | null = null;
let chipEl: HTMLElement | null = null;
let cachedResults: SourceRecord[] = [];

// ─── Editor Detection ─────────────────────────────────────────────────────

const EDITOR_SELECTORS = [
  '#prompt-textarea',
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"]',
  'textarea[placeholder]',
  'rich-textarea textarea',
  'textarea',
];

function findEditor(): HTMLElement | null {
  for (const sel of EDITOR_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el?.offsetParent) return el;
  }
  return null;
}

function readEditorText(el: HTMLElement): string {
  return el instanceof HTMLTextAreaElement ? el.value : el.textContent ?? '';
}

function isCursorAtEnd(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement)
    return el.selectionEnd >= el.value.trimEnd().length;
  const sel = window.getSelection();
  if (!sel?.rangeCount) return true;
  const range = sel.getRangeAt(0);
  const tail = document.createRange();
  tail.selectNodeContents(el);
  tail.setStart(range.endContainer, range.endOffset);
  return !tail.toString().trim();
}

// ─── Caret Position ───────────────────────────────────────────────────────

interface CaretXY { x: number; y: number; h: number }

function getCaretXY(el: HTMLElement): CaretXY | null {
  return el instanceof HTMLTextAreaElement ? textareaCaretXY(el) : contentEditableCaretXY(el);
}

function contentEditableCaretXY(el: HTMLElement): CaretXY | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return null;

  const collapsed = range.cloneRange();
  collapsed.collapse(false);
  const rect = collapsed.getBoundingClientRect();
  if (rect.height > 0) return { x: rect.right, y: rect.top, h: rect.height };

  const edRect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    x: edRect.left + parseFloat(cs.paddingLeft),
    y: edRect.top + parseFloat(cs.paddingTop),
    h: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4,
  };
}

function textareaCaretXY(ta: HTMLTextAreaElement): CaretXY | null {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement('div');

  const props = [
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
    'letter-spacing', 'word-spacing', 'text-indent', 'overflow-wrap',
    'word-break', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'box-sizing',
  ];
  for (const p of props) mirror.style.setProperty(p, cs.getPropertyValue(p));

  mirror.style.position = 'absolute';
  mirror.style.top = '-9999px';
  mirror.style.left = '-9999px';
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.overflow = 'hidden';
  mirror.style.visibility = 'hidden';

  mirror.textContent = ta.value.substring(0, ta.selectionEnd);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const taRect = ta.getBoundingClientRect();
  const borderL = parseFloat(cs.borderLeftWidth) || 0;
  const borderT = parseFloat(cs.borderTopWidth) || 0;

  const result: CaretXY = {
    x: taRect.left + borderL + (markerRect.left - mirrorRect.left) - ta.scrollLeft,
    y: taRect.top + borderT + (markerRect.top - mirrorRect.top) - ta.scrollTop,
    h: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4,
  };
  mirror.remove();
  return result;
}

// ─── Theme Detection ──────────────────────────────────────────────────────

function getElementBackground(el: HTMLElement | null): number[] | null {
  if (!el) return null;
  const bg = getComputedStyle(el).backgroundColor;
  const m = bg.match(/\d+/g);
  if (!m) return getElementBackground(el.parentElement);
  if (m.length >= 4 && parseFloat(m[3]) === 0) return getElementBackground(el.parentElement); // transparent
  return [+m[0], +m[1], +m[2]];
}

function isDarkBackground(el: HTMLElement): boolean {
  const m = getElementBackground(el);
  if (!m) return true; // default dark
  return (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255 < 0.5;
}

// ─── Floating Memory Chip ─────────────────────────────────────────────────

function ensureChip(anchor: HTMLElement): HTMLElement {
  if (chipEl && document.body.contains(chipEl)) return chipEl;

  chipEl = document.createElement('div');
  chipEl.id = 'xmem-chip';
  chipEl.className = isDarkBackground(anchor) ? 'xmem-dark-theme' : 'xmem-light-theme';
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
  chipEl.style.left = `${rect.right - 120}px`;
  chipEl.style.zIndex = '2147483647';
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

// ─── Ghost Text Rendering ─────────────────────────────────────────────────

function showGhost(answer: string, caret: CaretXY, editorRect: DOMRect, editor: HTMLElement) {
  dismissGhost();
  ghostAnswer = answer;
  const display = answer.length > MAX_GHOST_CHARS
    ? answer.slice(0, MAX_GHOST_CHARS).trimEnd() + '…'
    : answer;

  ghostEl = document.createElement('div');
  ghostEl.className = `xmem-ghost ${isDarkBackground(editor) ? 'xmem-dark' : 'xmem-light'}`;

  const textSpan = document.createElement('span');
  textSpan.className = 'xmem-ghost-text';
  textSpan.textContent = `  ${display}`;
  ghostEl.appendChild(textSpan);

  const tabBadge = document.createElement('span');
  tabBadge.className = 'xmem-ghost-tab';
  tabBadge.textContent = 'Tab';
  ghostEl.appendChild(tabBadge);

  const cs = getComputedStyle(editor);
  ghostEl.style.fontFamily = cs.fontFamily;
  ghostEl.style.fontSize = cs.fontSize;
  ghostEl.style.lineHeight = `${caret.h}px`;
  ghostEl.style.position = 'fixed';
  ghostEl.style.zIndex = '2147483647';
  ghostEl.style.pointerEvents = 'none';

  const spaceRight = editorRect.right - caret.x - 16;
  if (spaceRight > 100) {
    ghostEl.style.left = `${caret.x}px`;
    ghostEl.style.top = `${caret.y}px`;
    ghostEl.style.maxWidth = `${spaceRight}px`;
  } else {
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const bL = parseFloat(cs.borderLeftWidth) || 0;
    ghostEl.style.left = `${editorRect.left + bL + padL}px`;
    ghostEl.style.top = `${caret.y + caret.h}px`;
    ghostEl.style.maxWidth = `${editorRect.width - padL - padR - 16}px`;
  }

  document.body.appendChild(ghostEl);
}

function showLoadingGhost(caret: CaretXY, editor: HTMLElement) {
  dismissGhost();
  ghostEl = document.createElement('div');
  ghostEl.className = `xmem-ghost xmem-ghost-loading ${isDarkBackground(editor) ? 'xmem-dark' : 'xmem-light'}`;

  const dots = document.createElement('span');
  dots.className = 'xmem-ghost-dots';
  dots.textContent = '  ···';
  ghostEl.appendChild(dots);

  const cs = getComputedStyle(editor);
  ghostEl.style.fontFamily = cs.fontFamily;
  ghostEl.style.fontSize = cs.fontSize;
  ghostEl.style.lineHeight = `${caret.h}px`;
  ghostEl.style.position = 'fixed';
  ghostEl.style.left = `${caret.x}px`;
  ghostEl.style.top = `${caret.y}px`;
  ghostEl.style.zIndex = '2147483647';
  ghostEl.style.pointerEvents = 'none';

  document.body.appendChild(ghostEl);
}

function dismissGhost() {
  ghostEl?.remove();
  ghostEl = null;
  ghostAnswer = '';
}

function acceptGhost(): boolean {
  if (!ghostAnswer) return false;
  const editor = findEditor();
  if (!editor) return false;

  insertTextIntoEditor(editor, `\n${ghostAnswer}`);
  dismissGhost();
  showToast('Memory context added');
  return true;
}

function insertTextIntoEditor(el: HTMLElement, text: string) {
  if (el instanceof HTMLTextAreaElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    const pos = el.selectionEnd;
    const newVal = el.value.slice(0, pos) + text + el.value.slice(pos);
    if (nativeSetter) nativeSetter.call(el, newVal);
    else el.value = newVal;
    el.selectionStart = el.selectionEnd = pos + text.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    el.focus();
    document.execCommand('insertText', false, text);
  }
}

// ─── Autocomplete Engine ──────────────────────────────────────────────────

async function runAutocomplete(queryText: string) {
  if (queryText === prevQueryText) return;
  prevQueryText = queryText;

  if (inflightReq) inflightReq.cancelled = true;
  const thisReq = (inflightReq = { cancelled: false });

  const editor = findEditor();
  if (editor && isCursorAtEnd(editor)) {
    const pos = getCaretXY(editor);
    if (pos) showLoadingGhost(pos, editor);
  }

  updateChip(0, true);

  try {
    const results = await searchMemories(queryText, { topK: 5 });
    if (thisReq.cancelled) return;

    cachedResults = results;
    updateChip(results.length);

    if (results.length === 0 || results[0].score < MIN_RELEVANCE_SCORE) {
      dismissGhost();
      return;
    }

    // Since we found relevant memories, synthesize an answer for the ghost text
    const resp = await retrieveAnswer(queryText);
    if (thisReq.cancelled) return;

    if (!resp.answer) {
      dismissGhost();
      return;
    }

    const ed = findEditor();
    if (!ed || !isCursorAtEnd(ed)) { dismissGhost(); return; }

    const caret = getCaretXY(ed);
    if (!caret) { dismissGhost(); return; }

    const edRect = ed.getBoundingClientRect();
    if (caret.y < edRect.top - 5 || caret.y > edRect.bottom + 5) { dismissGhost(); return; }

    showGhost(resp.answer, caret, edRect, ed);
  } catch {
    updateChip(0);
    dismissGhost();
  }
}

// ─── Auto-save ────────────────────────────────────────────────────────────

function hookSendButtons() {
  const sendSelectors = [
    'button[data-testid="send-button"]',
    '#composer-submit-button',
    'button[aria-label="Send Message"]',
    'button[aria-label="Send message"]',
    'button[type="submit"]',
  ];
  for (const sel of sendSelectors) {
    const btn = document.querySelector<HTMLButtonElement>(sel);
    if (btn && !btn.dataset.xmemHooked) {
      btn.dataset.xmemHooked = '1';
      btn.addEventListener('click', () => { dismissGhost(); saveConversation(); }, true);
    }
  }
}

function hookEnterKey(editor: HTMLElement) {
  if (editor.dataset.xmemEnterHooked) return;
  editor.dataset.xmemEnterHooked = '1';
  editor.addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey) {
      savedInputText = readEditorText(editor);
      dismissGhost();
      setTimeout(saveConversation, 100);
    }
  });
}

async function saveConversation() {
  const enabled = await new Promise<boolean>(resolve => {
    if (!chrome?.storage?.sync) return resolve(false);
    chrome.storage.sync.get(['xmem_enabled'], d => resolve(d.xmem_enabled !== false))
  });
  if (!enabled) return;

  const editor = findEditor();
  const raw = savedInputText || (editor ? readEditorText(editor) : '');
  const cleaned = raw.replace(/<[^>]+>/g, '').trim();
  if (cleaned.length < 5) return;

  // 1. Trigger sidecar response
  triggerSidecar(cleaned);

  // 2. Save memory
  try { await ingestMemory(cleaned); }
  catch (err) { console.error('XMem: save failed', err); }
  savedInputText = '';
}

// ─── Memory Sidecar ───────────────────────────────────────────────────────

let activeSidecar: HTMLElement | null = null;
let sidecarTarget: HTMLElement | null = null;
let currentSidecarQuery = '';

async function triggerSidecar(query: string) {
  if (query === currentSidecarQuery) return;
  currentSidecarQuery = query;

  try {
    // 1. Check if there are relevant memories
    const results = await searchMemories(query, { topK: 5 });
    if (results.length === 0 || results[0].score < MIN_RELEVANCE_SCORE) {
      return; // No relevant memory, don't distract the user
    }

    // 2. Synthesize answer for the sidecar
    const resp = await retrieveAnswer(query);
    if (!resp || !resp.answer) return;

    // 3. Find the target AI response bubble
    const target = await pollForLatestAssistantMessage();
    if (!target) return;

    renderSidecar(target, resp);
  } catch (err) {
    console.error("XMem sidecar error", err);
  }
}

async function pollForLatestAssistantMessage(): Promise<HTMLElement | null> {
  // Poll for up to 10 seconds to find the newly generated AI response container
  for (let i = 0; i < 20; i++) {
    const nodes = document.querySelectorAll<HTMLElement>(
      '[data-message-author-role="assistant"], .font-claude-message, model-response, .prose'
    );
    if (nodes.length > 0) {
      // Find the last one (the most recent response)
      const last = nodes[nodes.length - 1];
      if (last.getBoundingClientRect().height > 0) return last;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

function renderSidecar(target: HTMLElement, resp: RetrieveResult) {
  if (activeSidecar) activeSidecar.remove();
  sidecarTarget = target;

  activeSidecar = document.createElement('div');
  activeSidecar.className = `xmem-sidecar ${isDarkBackground(document.body) ? 'xmem-dark-theme' : 'xmem-light-theme'}`;
  
  const sourcesHtml = resp.sources?.length 
    ? `<div class="xmem-sidecar-sources">${resp.sources.length} sources used</div>` 
    : '';

  activeSidecar.innerHTML = `
    <div class="xmem-sidecar-header">
      <div class="xmem-sidecar-logo-icon">X</div>
      <span class="xmem-sidecar-title">XMem Insight</span>
      <button class="xmem-sidecar-close">×</button>
    </div>
    <div class="xmem-sidecar-body">
      ${escapeHtml(resp.answer)}
      ${sourcesHtml}
    </div>
  `;

  document.body.appendChild(activeSidecar);

  activeSidecar.querySelector('.xmem-sidecar-close')?.addEventListener('click', () => {
    activeSidecar?.remove();
    activeSidecar = null;
    sidecarTarget = null;
  });

  updateSidecarPosition();
}

function updateSidecarPosition() {
  if (!activeSidecar || !sidecarTarget) return;
  const rect = sidecarTarget.getBoundingClientRect();
  
  if (rect.height === 0 || rect.width === 0) {
    activeSidecar.style.display = 'none';
    return;
  }
  activeSidecar.style.display = 'flex';

  const spaceLeft = rect.left;
  
  // Position on the left side (since left is cleaner for ChatGPT/Claude)
  if (spaceLeft > 320) {
    activeSidecar.style.top = `${Math.max(80, rect.top)}px`;
    activeSidecar.style.left = `${Math.max(10, rect.left - 320)}px`;
    activeSidecar.style.width = '300px';
  } else {
    // If not enough space on left, try top-right corner of the bubble (overlapping safely)
    activeSidecar.style.top = `${Math.max(80, rect.top - 60)}px`;
    activeSidecar.style.left = `${Math.max(10, rect.right - 300)}px`;
    activeSidecar.style.width = '280px';
  }
}

// Keep sidecar anchored during scrolling or streaming text
window.addEventListener('scroll', updateSidecarPosition, true);
window.addEventListener('resize', updateSidecarPosition);
setInterval(updateSidecarPosition, 200);

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

  sidebar.querySelectorAll<HTMLElement>('.xmem-sb-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      sidebar.querySelectorAll('.xmem-sb-tab').forEach(t => t.classList.remove('active'));
      sidebar.querySelectorAll('.xmem-sb-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      sidebar.querySelector(`#xmem-panel-${tab.dataset.tab}`)?.classList.add('active');
    });
  });

  const searchInput = sidebar.querySelector('#xmem-sb-search') as HTMLInputElement;
  searchInput?.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (q.length >= 3) doManualSearch(q);
    else if (q.length === 0) renderMemories(cachedResults);
  });

  sidebar.querySelector('#xmem-sb-save')?.addEventListener('click', async () => {
    const editor = findEditor();
    if (!editor) return;
    const text = readEditorText(editor).trim();
    if (!text) return;
    try { await ingestMemory(text); showToast('Memory saved!'); }
    catch { showToast('Failed to save memory', true); }
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
          <div class="xmem-answer-text">${escapeHtml(resp.answer || 'No answer generated.')}</div>
          ${(resp.sources?.length) ? `
            <div class="xmem-answer-sources">
              <span class="xmem-answer-sources-label">${resp.sources.length} source${resp.sources.length > 1 ? 's' : ''}</span>
              ${resp.sources.map((s: SourceRecord) => `
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

  sidebar.addEventListener('click', e => e.stopPropagation());
}

async function doManualSearch(query: string) {
  try {
    const results = await searchMemories(query, { topK: 15 });
    cachedResults = results;
    renderMemories(results);
  } catch { renderMemories([]); }
}

function toggleSidebar() {
  const sidebar = createSidebar();
  sidebarOpen = !sidebarOpen;
  sidebar.classList.toggle('xmem-sb-open', sidebarOpen);
  if (sidebarOpen) {
    renderMemories(cachedResults);
    document.addEventListener('click', outsideClickHandler);
    document.addEventListener('keydown', sidebarEscHandler);
  } else {
    document.removeEventListener('click', outsideClickHandler);
    document.removeEventListener('keydown', sidebarEscHandler);
  }
}

function outsideClickHandler(e: MouseEvent) {
  if (sidebarEl && !sidebarEl.contains(e.target as Node)) {
    if (sidebarOpen) toggleSidebar();
  }
}

function sidebarEscHandler(e: KeyboardEvent) {
  if (e.key === 'Escape' && sidebarOpen) toggleSidebar();
}

function renderMemories(memories: SourceRecord[]) {
  const panel = document.getElementById('xmem-panel-memories');
  if (!panel) return;

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

  panel.querySelectorAll<HTMLElement>('.xmem-copy-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx || '0', 10);
      const mem = memories[idx];
      if (mem) {
        navigator.clipboard.writeText(mem.content).then(() => {
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
          setTimeout(() => {
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
          }, 1500);
        });
      }
    });
  });

  panel.querySelectorAll<HTMLElement>('.xmem-inject-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx || '0', 10);
      const mem = memories[idx];
      if (mem) {
        const editor = findEditor();
        if (editor) {
          insertTextIntoEditor(editor, `\n\n[XMem/${mem.domain}] ${mem.content}`);
          showToast('Memory added to prompt');
        }
      }
    });
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────

function showToast(msg: string, isError = false) {
  document.getElementById('xmem-toast')?.remove();
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

// ─── Utilities ────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ─── Styles ───────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('xmem-styles')) return;
  const style = document.createElement('style');
  style.id = 'xmem-styles';
  style.textContent = `
    /* ═══ Ghost Text Autocomplete ═══ */
    .xmem-ghost {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      opacity: 0;
      animation: xmem-ghost-appear 0.2s ease forwards;
      white-space: nowrap;
      overflow: hidden;
      font-family: inherit;
    }
    .xmem-ghost-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .xmem-dark .xmem-ghost-text { color: rgba(255, 255, 255, 0.30); }
    .xmem-light .xmem-ghost-text { color: rgba(0, 0, 0, 0.30); }
    .xmem-ghost-dots {
      animation: xmem-pulse 1s ease infinite;
    }
    .xmem-dark .xmem-ghost-dots { color: rgba(255, 255, 255, 0.22); }
    .xmem-light .xmem-ghost-dots { color: rgba(0, 0, 0, 0.22); }
    .xmem-ghost-tab {
      flex-shrink: 0;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      letter-spacing: 0.3px;
      white-space: nowrap;
    }
    .xmem-dark .xmem-ghost-tab {
      background: rgba(124, 58, 237, 0.12);
      color: rgba(124, 58, 237, 0.50);
    }
    .xmem-light .xmem-ghost-tab {
      background: rgba(124, 58, 237, 0.08);
      color: rgba(124, 58, 237, 0.55);
    }
    @keyframes xmem-ghost-appear {
      from { opacity: 0; transform: translateX(6px); }
      to { opacity: 1; transform: none; }
    }
    @keyframes xmem-pulse { 50% { opacity: 0.35; } }

    /* ═══ Toast ═══ */
    #xmem-toast {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      position: fixed; bottom: 24px; left: 50%;
      transform: translateX(-50%) translateY(20px);
      padding: 10px 20px; border-radius: 8px;
      font-size: 13px; font-weight: 500;
      z-index: 2147483647; opacity: 0;
      transition: opacity 0.3s, transform 0.3s;
      pointer-events: none;
    }
    #xmem-toast.xmem-toast-visible { opacity: 1; transform: translateX(-50%) translateY(0); }
    .xmem-toast-success { background: #22c55e20; color: #4ade80; border: 1px solid #22c55e40; }
    .xmem-toast-error { background: #ef444420; color: #f87171; border: 1px solid #ef444440; }

    /* ═══ Chip ═══ */
    #xmem-chip {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      position: fixed;
      transition: opacity 0.2s, transform 0.2s;
      pointer-events: auto;
      cursor: pointer;
    }
    .xmem-chip-inner {
      display: flex; align-items: center; gap: 5px;
      padding: 5px 12px; border-radius: 20px;
      font-size: 12px; font-weight: 500;
      box-shadow: 0 2px 10px rgba(0,0,0,0.15);
      transition: all 0.25s;
      user-select: none;
    }
    
    .xmem-dark-theme .xmem-chip-inner {
      background: #1e1e24; border: 1px solid #333; color: #71717a;
    }
    .xmem-light-theme .xmem-chip-inner {
      background: #ffffff; border: 1px solid #e4e4e7; color: #71717a;
    }
    
    .xmem-chip-inner:hover {
      border-color: #7c3aed; color: #7c3aed;
      box-shadow: 0 2px 16px rgba(124,58,237,0.2);
    }
    
    .xmem-dark-theme .xmem-chip-inner.xmem-chip-active {
      background: linear-gradient(135deg, #1a1a2e, #16213e);
      border-color: #7c3aed; color: #c4b5fd;
    }
    .xmem-light-theme .xmem-chip-inner.xmem-chip-active {
      background: linear-gradient(135deg, #f5f3ff, #ede9fe);
      border-color: #7c3aed; color: #6d28d9;
    }
    
    .xmem-chip-inner.xmem-chip-loading {
      border-color: #f59e0b !important; color: #d97706 !important;
    }
    .xmem-chip-icon { display: flex; align-items: center; }
    .xmem-chip-count { font-weight: 700; font-size: 13px; }

    /* ═══ Sidecar ═══ */
    .xmem-sidecar {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      position: fixed;
      z-index: 2147483646;
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 4px 24px rgba(0,0,0,0.15);
      animation: xmem-slide-in 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      overflow: hidden;
      border: 1px solid transparent;
      transition: top 0.2s, left 0.2s;
    }

    .xmem-dark-theme.xmem-sidecar {
      background: #18181b;
      border-color: #3f3f46;
      color: #e4e4e7;
    }

    .xmem-light-theme.xmem-sidecar {
      background: #ffffff;
      border-color: #e4e4e7;
      color: #27272a;
    }

    .xmem-sidecar-header {
      display: flex;
      align-items: center;
      padding: 10px 14px;
      gap: 8px;
      border-bottom: 1px solid;
    }
    
    .xmem-dark-theme .xmem-sidecar-header {
      background: linear-gradient(135deg, #1a1a2e, #16213e);
      border-bottom-color: #27272a;
    }
    .xmem-light-theme .xmem-sidecar-header {
      background: linear-gradient(135deg, #f5f3ff, #ede9fe);
      border-bottom-color: #e4e4e7;
    }

    .xmem-sidecar-logo-icon {
      width: 20px; height: 20px;
      background: linear-gradient(135deg, #7c3aed, #3b82f6);
      border-radius: 6px; display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 800; color: white;
    }

    .xmem-sidecar-title {
      font-size: 13px; font-weight: 600; flex: 1;
      color: inherit;
    }

    .xmem-dark-theme .xmem-sidecar-title { color: #fff; }
    .xmem-light-theme .xmem-sidecar-title { color: #18181b; }

    .xmem-sidecar-close {
      background: none; border: none;
      color: #a1a1aa; font-size: 16px; cursor: pointer;
      padding: 0 4px; line-height: 1; border-radius: 4px;
    }
    .xmem-sidecar-close:hover { background: rgba(128,128,128,0.2); color: inherit; }

    .xmem-sidecar-body {
      padding: 14px;
      font-size: 13px;
      line-height: 1.5;
      max-height: 300px;
      overflow-y: auto;
    }

    .xmem-sidecar-sources {
      margin-top: 12px;
      font-size: 11px;
      color: #a1a1aa;
      border-top: 1px solid;
      padding-top: 8px;
    }
    .xmem-dark-theme .xmem-sidecar-sources { border-top-color: #27272a; }
    .xmem-light-theme .xmem-sidecar-sources { border-top-color: #e4e4e7; }

    @keyframes xmem-slide-in {
      from { opacity: 0; transform: translateY(10px) scale(0.98); }
      to { opacity: 1; transform: none; }
    }

    /* ═══ Fact Check Badge ═══ */
    .xmem-fact-check-badge {
      position: absolute;
      top: -10px;
      right: -10px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 20px;
      font-size: 10px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      cursor: help;
      z-index: 100;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      transition: all 0.2s;
    }
    
    .xmem-dark-theme.xmem-fact-check-badge {
      background: #3f3f46;
      border: 1px solid #52525b;
      color: #fbbf24;
    }
    
    .xmem-light-theme.xmem-fact-check-badge {
      background: #fef3c7;
      border: 1px solid #fde68a;
      color: #b45309;
    }
    
    .xmem-fact-icon { display: flex; align-items: center; }
    
    .xmem-fact-tooltip {
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 6px;
      width: 250px;
      padding: 10px;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.5;
      font-weight: 400;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.2s, visibility 0.2s;
      box-shadow: 0 4px 16px rgba(0,0,0,0.15);
      z-index: 101;
      text-transform: none;
    }
    
    .xmem-dark-theme .xmem-fact-tooltip {
      background: #27272a;
      border: 1px solid #3f3f46;
      color: #e4e4e7;
    }
    
    .xmem-light-theme .xmem-fact-tooltip {
      background: #ffffff;
      border: 1px solid #e4e4e7;
      color: #27272a;
    }
    
    .xmem-fact-check-badge:hover .xmem-fact-tooltip {
      opacity: 1;
      visibility: visible;
    }

    /* ═══ Sidebar ═══ */
    #xmem-sidebar {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
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
      border-bottom: 1px solid #27272a; flex-shrink: 0;
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
      display: flex; border-bottom: 1px solid #27272a; flex-shrink: 0;
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

    .xmem-memory-card {
      background: #18181b; border: 1px solid #27272a; border-radius: 10px;
      padding: 12px; margin-bottom: 8px;
      transition: border-color 0.2s, background 0.2s;
    }
    .xmem-memory-card:hover { border-color: #333; background: #1e1e24; }
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
      font-size: 11px; font-weight: 500; transition: all 0.2s;
    }
    .xmem-copy-btn:hover, .xmem-inject-btn:hover {
      background: #333; color: #fff; border-color: #7c3aed;
    }

    .xmem-empty {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; padding: 48px 16px; text-align: center; gap: 10px;
    }
    .xmem-empty p { color: #71717a; font-size: 14px; font-weight: 500; }
    .xmem-empty span { color: #52525b; font-size: 12px; }

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
    .xmem-answer {
      padding: 12px; background: #18181b;
      border: 1px solid #27272a; border-radius: 8px;
    }
    .xmem-answer-text { font-size: 13px; line-height: 1.6; color: #d4d4d8; }
    .xmem-answer-sources {
      margin-top: 10px; border-top: 1px solid #27272a; padding-top: 8px;
    }
    .xmem-answer-sources-label {
      font-size: 11px; color: #71717a; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .xmem-source-item {
      display: flex; align-items: flex-start; gap: 6px;
      margin-top: 6px; font-size: 12px; color: #a1a1aa;
    }
    .xmem-error { color: #ef4444; font-size: 13px; padding: 10px; }

    .xmem-sb-footer {
      padding: 10px 16px; border-top: 1px solid #27272a;
      font-size: 11px; color: #52525b; text-align: center; flex-shrink: 0;
    }
    .xmem-sb-footer kbd {
      background: #27272a; padding: 1px 5px; border-radius: 4px;
      font-family: inherit;
    }

    .xmem-loader {
      width: 20px; height: 20px; border: 2px solid #333;
      border-top-color: #7c3aed; border-radius: 50%;
      animation: xmem-spin 0.8s linear infinite;
      margin: 20px auto;
    }
    @keyframes xmem-spin { to { transform: rotate(360deg); } }

    /* ═══ Highlight Button ═══ */
    .xmem-highlight-btn {
      position: fixed;
      display: none;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      z-index: 2147483647;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      animation: xmem-pop 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      transition: background 0.2s, border-color 0.2s;
    }
    .xmem-highlight-btn:hover { filter: brightness(1.1); }
    
    .xmem-dark-theme.xmem-highlight-btn {
      background: #27272a; border: 1px solid #3f3f46; color: #e4e4e7;
    }
    .xmem-light-theme.xmem-highlight-btn {
      background: #ffffff; border: 1px solid #e4e4e7; color: #27272a;
    }

    .xmem-hl-icon {
      width: 18px; height: 18px;
      background: linear-gradient(135deg, #7c3aed, #3b82f6);
      border-radius: 4px; display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 800; color: white;
    }
    
    .xmem-highlight-btn.xmem-hl-success {
      background: #22c55e; border-color: #16a34a; color: white;
    }
    .xmem-highlight-btn.xmem-hl-success .xmem-hl-icon { display: none; }

    @keyframes xmem-pop {
      from { opacity: 0; transform: translate(-50%, 10px) scale(0.9); }
      to { opacity: 1; transform: translate(-50%, 0) scale(1); }
    }
  `;
  document.head.appendChild(style);
}

// ─── Fact Checker / Memory Conflict Detector ────────────────────────────────

let factCheckTimer: ReturnType<typeof setTimeout> | null = null;
const factCheckedNodes = new WeakSet<HTMLElement>();

function observeAIResponsesForFactChecking() {
  const mo = new MutationObserver(() => {
    if (factCheckTimer) clearTimeout(factCheckTimer);
    factCheckTimer = setTimeout(runFactCheck, 2000); // Wait for stream to settle a bit
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
}

async function runFactCheck() {
  const enabled = await new Promise<boolean>(resolve => {
    if (!chrome?.storage?.sync) return resolve(false);
    chrome.storage.sync.get(['xmem_enabled'], d => resolve(d.xmem_enabled !== false));
  });
  if (!enabled) return;

  const nodes = document.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"], .font-claude-message, model-response, .prose');
  const latestNode = nodes[nodes.length - 1];
  
  if (!latestNode || factCheckedNodes.has(latestNode)) return;
  
  // Basic heuristic: check if it's done streaming (has enough length and hasn't changed in the last 2s)
  const text = latestNode.textContent?.trim();
  if (!text || text.length < 50) return;

  // We only check once per response node to save API calls
  factCheckedNodes.add(latestNode);

  try {
    // 1. Ask XMem to retrieve relevant facts about the AI's response text
    // (In a real app, we'd have a specialized /fact_check endpoint, but we can simulate it with retrieveAnswer)
    const query = `Is this true based on my memories? "${text.substring(0, 500)}"`;
    const resp = await retrieveAnswer(query);
    
    if (resp && resp.sources && resp.sources.length > 0) {
      // Very simple heuristic: if XMem found sources and synthesized an answer, inject a subtle "Fact Check" badge
      injectFactCheckBadge(latestNode, resp.answer);
    }
  } catch (err) {
    console.error("XMem fact check error", err);
  }
}

function injectFactCheckBadge(node: HTMLElement, feedback: string) {
  // Ensure relative positioning context
  if (getComputedStyle(node).position === 'static') {
    node.style.position = 'relative';
  }

  const badge = document.createElement('div');
  badge.className = `xmem-fact-check-badge ${isDarkBackground(document.body) ? 'xmem-dark-theme' : 'xmem-light-theme'}`;
  badge.innerHTML = `
    <span class="xmem-fact-icon">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
    </span>
    <span class="xmem-fact-text">Memory Match</span>
    <div class="xmem-fact-tooltip">${escapeHtml(feedback)}</div>
  `;

  node.appendChild(badge);
}

// ─── Highlight-to-Remember ────────────────────────────────────────────────

let highlightBtn: HTMLElement | null = null;
let currentSelectionText = '';

function setupHighlightToRemember() {
  document.addEventListener('mouseup', handleSelection);
  document.addEventListener('mousedown', (e) => {
    if (highlightBtn && highlightBtn.contains(e.target as Node)) {
      return;
    }
    dismissHighlightBtn();
  });
  
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      dismissHighlightBtn();
    }
  });
}

function handleSelection(e: MouseEvent) {
  setTimeout(async () => {
    const enabled = await new Promise<boolean>(resolve => {
      if (!chrome?.storage?.sync) return resolve(false);
      chrome.storage.sync.get(['xmem_enabled'], d => resolve(d.xmem_enabled !== false));
    });
    if (!enabled) return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      dismissHighlightBtn();
      return;
    }

    const text = sel.toString().trim();
    if (text.length < 5) {
      dismissHighlightBtn();
      return;
    }

    if (activeSidecar?.contains(sel.anchorNode) || 
        sidebarEl?.contains(sel.anchorNode) || 
        highlightBtn?.contains(sel.anchorNode)) {
      return;
    }

    const editor = findEditor();
    if (editor && editor.contains(sel.anchorNode)) {
      return;
    }

    currentSelectionText = text;
    showHighlightBtn(sel, e);
  }, 10);
}

function showHighlightBtn(sel: Selection, e: MouseEvent) {
  if (!highlightBtn) {
    highlightBtn = document.createElement('div');
    highlightBtn.id = 'xmem-highlight-btn';
    highlightBtn.innerHTML = `
      <div class="xmem-hl-icon">X</div>
      <span>Remember</span>
    `;
    
    highlightBtn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });

    highlightBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const textToSave = currentSelectionText;
      if (!textToSave) return;
      
      if (highlightBtn) {
        highlightBtn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>Saved</span>
        `;
        highlightBtn.classList.add('xmem-hl-success');
      }

      try {
        await ingestMemory(textToSave);
      } catch (err) {
        console.error("XMem highlight save failed", err);
      }

      setTimeout(() => {
        dismissHighlightBtn();
        window.getSelection()?.removeAllRanges();
      }, 1500);
    });
    
    document.body.appendChild(highlightBtn);
  }

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  
  const top = rect.top > 0 ? rect.top : e.clientY;
  const left = rect.left > 0 ? rect.left + rect.width / 2 : e.clientX;

  highlightBtn.className = `xmem-highlight-btn ${isDarkBackground(document.body) ? 'xmem-dark-theme' : 'xmem-light-theme'}`;
  
  highlightBtn.style.top = `${top - 40}px`;
  highlightBtn.style.left = `${left}px`;
  highlightBtn.style.display = 'flex';
}

function dismissHighlightBtn() {
  if (highlightBtn) {
    highlightBtn.style.display = 'none';
    highlightBtn.classList.remove('xmem-hl-success');
    highlightBtn.innerHTML = `
      <div class="xmem-hl-icon">X</div>
      <span>Remember</span>
    `;
  }
  currentSelectionText = '';
}

// ─── Main Loop ────────────────────────────────────────────────────────────

function mainLoop() {
  const editor = findEditor();
  if (!editor) return;

  ensureChip(editor);
  positionChip(editor);

  hookSendButtons();
  hookEnterKey(editor);

  if (editor.dataset.xmemBound) return;
  editor.dataset.xmemBound = '1';

  const onInput = () => {
    dismissGhost();
    if (!chrome?.storage?.sync) return;
    chrome.storage.sync.get(['xmem_enabled', 'xmem_live_suggest'], data => {
      if (data.xmem_enabled === false || data.xmem_live_suggest === false) return;
      const text = readEditorText(editor).trim();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (text.length >= MIN_QUERY_LEN && isCursorAtEnd(editor)) {
        showChip();
        debounceTimer = setTimeout(() => runAutocomplete(text), DEBOUNCE_MS);
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

  // Tab to accept / Escape to dismiss — capture phase to fire before platform handlers
  editor.addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Tab' && ghostAnswer) {
      ke.preventDefault();
      ke.stopPropagation();
      acceptGhost();
    } else if (ke.key === 'Escape' && ghostAnswer) {
      ke.preventDefault();
      ke.stopPropagation();
      dismissGhost();
    }
  }, true);

  editor.addEventListener('blur', () => dismissGhost());
  editor.addEventListener('scroll', () => {
    if (!ghostAnswer) return;
    const pos = getCaretXY(editor);
    if (!pos || !ghostEl) { dismissGhost(); return; }
    const edRect = editor.getBoundingClientRect();
    if (pos.y < edRect.top || pos.y > edRect.bottom) { dismissGhost(); return; }
    ghostEl.style.left = `${pos.x}px`;
    ghostEl.style.top = `${pos.y}px`;
  });
}

// Dismiss ghost when cursor moves away from end
document.addEventListener('selectionchange', () => {
  if (!ghostAnswer) return;
  const ed = findEditor();
  if (!ed || !isCursorAtEnd(ed)) dismissGhost();
});

let observerActive = false;

function startObserver() {
  if (observerActive) return;
  observerActive = true;
  new MutationObserver(mainLoop).observe(document.body, { childList: true, subtree: true });
  observeAIResponsesForFactChecking();
  setupHighlightToRemember();
  mainLoop();
}

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key === 'M') {
    e.preventDefault();
    toggleSidebar();
  }
});

chrome.runtime.onMessage.addListener(request => {
  if (request.action === 'xmem_toggle_sidebar') toggleSidebar();
  return undefined;
});

// ─── Boot ─────────────────────────────────────────────────────────────────

injectStyles();
startObserver();

/**
 * XMem Content Script — Inline memory autocomplete for AI chat UIs.
 *
 * As you type in ChatGPT / Claude / Gemini / Perplexity, XMem searches
 * your memory and shows ghost-text suggestions inline. Press Tab to
 * accept the suggestion, Escape to dismiss. Ctrl+Shift+M opens the
 * full memory sidebar.
 */

import {
  retrieveAnswer,
  searchMemories,
  ingestMemory,
  queryCode,
  streamCodeQuery,
  getDirectoryTree,
  listRepos,
  type SourceRecord,
  type RetrieveResult,
  type DirectoryNode,
  type CodeQueryResult,
} from "./api";

// ─── Config ───────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 600;
const MIN_QUERY_LEN = 8;
const MAX_GHOST_CHARS = 150;
const MIN_RELEVANCE_SCORE = 0.4;

// ─── State ────────────────────────────────────────────────────────────────

let ghostEl: HTMLElement | null = null;
let ghostAnswer = "";
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inflightReq: { cancelled: boolean } | null = null;
let prevQueryText = "";
let savedInputText = "";

let sidebarOpen = false;
let sidebarEl: HTMLElement | null = null;
let chipEl: HTMLElement | null = null;
let cachedResults: SourceRecord[] = [];

// ─── Mode State ───────────────────────────────────────────────────────────

type XMemMode = "ingest" | "search" | "ide" | "repo";
let xmemMode: XMemMode = "search";

// ─── Effort Level State ───────────────────────────────────────────────────

type EffortLevel = "low" | "high";
let xmemEffortLevel: EffortLevel = "low";

// ─── IDE Mode State ───────────────────────────────────────────────────────

let idePanelEl: HTMLElement | null = null;
let idePanelOpen = false;
let ideOrgId = "";
let ideRepo = "";
let ideTreeData: DirectoryNode | null = null;
let bypassContextInjection = false;

// ─── Slash Command State ──────────────────────────────────────────────────

let slashDropdownEl: HTMLElement | null = null;
let slashSelectedIdx = 0;

// ─── Editor Detection ─────────────────────────────────────────────────────

const EDITOR_SELECTORS = [
  "#prompt-textarea",
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"]',
  "textarea[placeholder]",
  "rich-textarea textarea",
  "textarea",
];

function findEditor(): HTMLElement | null {
  for (const sel of EDITOR_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el?.offsetParent) return el;
  }
  return null;
}

function readEditorText(el: HTMLElement): string {
  return el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? "");
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

interface CaretXY {
  x: number;
  y: number;
  h: number;
}

function getCaretXY(el: HTMLElement): CaretXY | null {
  return el instanceof HTMLTextAreaElement
    ? textareaCaretXY(el)
    : contentEditableCaretXY(el);
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
  const mirror = document.createElement("div");

  const props = [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "word-spacing",
    "text-indent",
    "overflow-wrap",
    "word-break",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "box-sizing",
  ];
  for (const p of props) mirror.style.setProperty(p, cs.getPropertyValue(p));

  mirror.style.position = "absolute";
  mirror.style.top = "-9999px";
  mirror.style.left = "-9999px";
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflow = "hidden";
  mirror.style.visibility = "hidden";

  mirror.textContent = ta.value.substring(0, ta.selectionEnd);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const taRect = ta.getBoundingClientRect();
  const borderL = parseFloat(cs.borderLeftWidth) || 0;
  const borderT = parseFloat(cs.borderTopWidth) || 0;

  const result: CaretXY = {
    x:
      taRect.left +
      borderL +
      (markerRect.left - mirrorRect.left) -
      ta.scrollLeft,
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
  if (m.length >= 4 && parseFloat(m[3]) === 0)
    return getElementBackground(el.parentElement); // transparent
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

  chipEl = document.createElement("div");
  chipEl.id = "xmem-chip";
  chipEl.className = isDarkBackground(anchor)
    ? "xmem-dark-theme"
    : "xmem-light-theme";
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
  chipEl.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSidebar();
  });

  return chipEl;
}

function positionChip(anchor: HTMLElement) {
  if (!chipEl) return;
  const rect = anchor.getBoundingClientRect();
  chipEl.style.position = "fixed";
  chipEl.style.top = `${rect.top - 36}px`;
  chipEl.style.left = `${rect.right - 120}px`;
  chipEl.style.zIndex = "2147483647";
}

function updateChip(count: number, loading = false) {
  if (!chipEl) return;
  const countEl = chipEl.querySelector(".xmem-chip-count");
  const labelEl = chipEl.querySelector(".xmem-chip-label");
  const inner = chipEl.querySelector(".xmem-chip-inner") as HTMLElement;

  if (countEl) countEl.textContent = loading ? "..." : String(count);
  if (labelEl)
    labelEl.textContent = loading
      ? "searching"
      : count === 1
        ? "memory"
        : "memories";
  if (inner) {
    inner.classList.toggle("xmem-chip-active", count > 0 || loading);
    inner.classList.toggle("xmem-chip-loading", loading);
  }
}

function hideChip() {
  if (chipEl) chipEl.style.display = "none";
}

function showChip() {
  if (chipEl) chipEl.style.display = "block";
}

// ─── Ghost Text Rendering ─────────────────────────────────────────────────

function showGhost(
  answer: string,
  caret: CaretXY,
  editorRect: DOMRect,
  editor: HTMLElement,
) {
  dismissGhost();
  ghostAnswer = answer;
  const display =
    answer.length > MAX_GHOST_CHARS
      ? answer.slice(0, MAX_GHOST_CHARS).trimEnd() + "…"
      : answer;

  const currentText = readEditorText(editor);
  const endsWithSpace = /[\s\n]$/.test(currentText);
  const startsWithPunctuation = /^[.,?!:;]/.test(answer);

  let prefix = "";
  if (currentText.endsWith("?")) {
    prefix = "  ⏎  "; // visual indicator of a newline answer
  } else if (
    !endsWithSpace &&
    !startsWithPunctuation &&
    currentText.length > 0
  ) {
    prefix = " ";
  }

  ghostEl = document.createElement("div");
  ghostEl.className = `xmem-ghost ${isDarkBackground(editor) ? "xmem-dark" : "xmem-light"}`;

  const textSpan = document.createElement("span");
  textSpan.className = "xmem-ghost-text";
  textSpan.textContent = `${prefix}${display}`;
  ghostEl.appendChild(textSpan);

  const tabBadge = document.createElement("span");
  tabBadge.className = "xmem-ghost-tab";
  tabBadge.textContent = "Tab";
  ghostEl.appendChild(tabBadge);

  const cs = getComputedStyle(editor);
  ghostEl.style.fontFamily = cs.fontFamily;
  ghostEl.style.fontSize = cs.fontSize;
  ghostEl.style.lineHeight = `${caret.h}px`;
  ghostEl.style.position = "fixed";
  ghostEl.style.zIndex = "2147483647";
  ghostEl.style.pointerEvents = "none";

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
  ghostEl = document.createElement("div");
  ghostEl.className = `xmem-ghost xmem-ghost-loading ${isDarkBackground(editor) ? "xmem-dark" : "xmem-light"}`;

  const dots = document.createElement("span");
  dots.className = "xmem-ghost-dots";
  dots.textContent = "  ···";
  ghostEl.appendChild(dots);

  const cs = getComputedStyle(editor);
  ghostEl.style.fontFamily = cs.fontFamily;
  ghostEl.style.fontSize = cs.fontSize;
  ghostEl.style.lineHeight = `${caret.h}px`;
  ghostEl.style.position = "fixed";
  ghostEl.style.left = `${caret.x}px`;
  ghostEl.style.top = `${caret.y}px`;
  ghostEl.style.zIndex = "2147483647";
  ghostEl.style.pointerEvents = "none";

  document.body.appendChild(ghostEl);
}

function dismissGhost() {
  ghostEl?.remove();
  ghostEl = null;
  ghostAnswer = "";
}

function acceptGhost(): boolean {
  if (!ghostAnswer) return false;
  const editor = findEditor();
  if (!editor) return false;

  const currentText = readEditorText(editor);
  const endsWithSpace = /[\s\n]$/.test(currentText);
  const startsWithPunctuation = /^[.,?!:;]/.test(ghostAnswer);

  let prefix = "";
  if (currentText.endsWith("?")) {
    prefix = "\n\n";
  } else if (
    !endsWithSpace &&
    !startsWithPunctuation &&
    currentText.length > 0
  ) {
    prefix = " ";
  }

  insertTextIntoEditor(editor, `${prefix}${ghostAnswer}`);
  dismissGhost();
  showToast("Memory context added");
  return true;
}

function insertTextIntoEditor(el: HTMLElement, text: string) {
  if (el instanceof HTMLTextAreaElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    const pos = el.selectionEnd;
    const newVal = el.value.slice(0, pos) + text + el.value.slice(pos);
    if (nativeSetter) nativeSetter.call(el, newVal);
    else el.value = newVal;
    el.selectionStart = el.selectionEnd = pos + text.length;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    el.focus();
    document.execCommand("insertText", false, text);
  }
}

// ─── Autocomplete Engine ──────────────────────────────────────────────────

async function runAutocomplete(queryText: string) {
  // Only run autocomplete in search mode
  if (xmemMode !== "search") return;

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
    if (!ed || !isCursorAtEnd(ed)) {
      dismissGhost();
      return;
    }

    const caret = getCaretXY(ed);
    if (!caret) {
      dismissGhost();
      return;
    }

    const edRect = ed.getBoundingClientRect();
    if (caret.y < edRect.top - 5 || caret.y > edRect.bottom + 5) {
      dismissGhost();
      return;
    }

    showGhost(resp.answer, caret, edRect, ed);
  } catch {
    updateChip(0);
    dismissGhost();
  }
}

// ─── Auto-save ────────────────────────────────────────────────────────────

function findSendButton(): HTMLButtonElement | null {
  const sels = [
    'button[data-testid="send-button"]',
    "#composer-submit-button",
    'button[aria-label="Send Message"]',
    'button[aria-label="Send message"]',
    'button[type="submit"]',
  ];
  for (const sel of sels) {
    const btn = document.querySelector<HTMLButtonElement>(sel);
    if (btn) return btn;
  }
  return null;
}

function hookSendButtons() {
  const sels = [
    'button[data-testid="send-button"]',
    "#composer-submit-button",
    'button[aria-label="Send Message"]',
    'button[aria-label="Send message"]',
    'button[type="submit"]',
  ];
  for (const sel of sels) {
    const btn = document.querySelector<HTMLButtonElement>(sel);
    if (btn && !btn.dataset.xmemHooked) {
      btn.dataset.xmemHooked = "1";
      btn.addEventListener(
        "click",
        (e) => {
          if (
            (xmemMode === "ide" || xmemMode === "search") &&
            !bypassContextInjection
          ) {
            e.preventDefault();
            e.stopImmediatePropagation();
            const editor = findEditor();
            if (editor) injectContextAndSend(editor);
            return;
          }
          if (bypassContextInjection) {
            bypassContextInjection = false;
          }
          dismissGhost();
          saveConversation();
        },
        true,
      );
    }
  }
}

function hookEnterKey(editor: HTMLElement) {
  if (editor.dataset.xmemEnterHooked) return;
  editor.dataset.xmemEnterHooked = "1";
  editor.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && !ke.shiftKey) {
      savedInputText = readEditorText(editor);
      dismissGhost();
      setTimeout(saveConversation, 100);
    }
  });
}

// ─── Ingest Status Banner ─────────────────────────────────────────────────

function showIngestStatus(
  status: "pending" | "success" | "error",
): HTMLElement | null {
  // Remove any previous ingest status
  document.querySelectorAll(".xmem-ingest-status").forEach((el) => el.remove());

  const banner = document.createElement("div");
  banner.className = `xmem-ingest-status xmem-ingest-${status}`;

  if (status === "pending") {
    banner.innerHTML = `
      <div class="xmem-ingest-spinner"></div>
      <span>Conversation queued for memorization…</span>
    `;
  }

  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add("xmem-status-visible"));

  return banner;
}

function updateIngestStatus(el: HTMLElement, status: "success" | "error") {
  el.className = `xmem-ingest-status xmem-ingest-${status} xmem-status-visible`;

  if (status === "success") {
    el.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <span>Conversation committed to memory</span>
    `;
  } else {
    el.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
      <span>Memory save failed — will retry next turn</span>
    `;
  }

  // Auto-remove after a few seconds
  setTimeout(
    () => {
      el.classList.remove("xmem-status-visible");
      setTimeout(() => el.remove(), 400);
    },
    status === "success" ? 3000 : 5000,
  );
}

function showIngestQueued() {
  document.querySelectorAll(".xmem-ingest-status").forEach((el) => el.remove());

  const banner = document.createElement("div");
  banner.className = "xmem-ingest-status xmem-ingest-success";
  banner.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
    <span>Conversation memorized</span>
  `;

  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add("xmem-status-visible"));

  setTimeout(() => {
    banner.classList.remove("xmem-status-visible");
    setTimeout(() => banner.remove(), 400);
  }, 3000);
}

// ─── Ingestion Queue ──────────────────────────────────────────────────────

interface IngestQueueItem {
  id: number;
  userText: string;
  timestamp: number;
}

let queueBadgeEl: HTMLElement | null = null;

class IngestionQueue {
  private queue: IngestQueueItem[] = [];
  private processing = false;
  private nextId = 1;

  enqueue(userText: string) {
    this.queue.push({
      id: this.nextId++,
      userText,
      timestamp: Date.now(),
    });
    this.renderBadge();

    if (!this.processing) {
      this.processNext();
    }
  }

  private async processNext() {
    if (this.queue.length === 0) {
      this.processing = false;
      this.hideBadge();
      return;
    }

    this.processing = true;
    const item = this.queue[0];
    this.renderBadge();

    try {
      const agentResponse = await captureLatestAgentResponse();
      await ingestMemory(item.userText, agentResponse, xmemEffortLevel);
      this.queue.shift();
      console.log(`[XMem] Queue: ingested item #${item.id}, ${this.queue.length} remaining`);
    } catch (err) {
      console.error(`[XMem] Queue: ingestion failed for item #${item.id}`, err);
      this.queue.shift();
      this.flashError();
    }

    this.renderBadge();
    this.processNext();
  }

  private ensureBadge() {
    if (queueBadgeEl) return;
    queueBadgeEl = document.createElement("div");
    queueBadgeEl.className = "xmem-queue-badge";
    document.body.appendChild(queueBadgeEl);
  }

  private renderBadge() {
    this.ensureBadge();
    const pending = this.queue.length;

    if (pending === 0) {
      this.hideBadge();
      return;
    }

    queueBadgeEl!.innerHTML = `
      <div class="xmem-queue-spinner"></div>
      <span>Syncing${pending > 1 ? ` ${pending} conversations` : ""}…</span>
    `;
    queueBadgeEl!.classList.add("xmem-queue-visible");
  }

  private hideBadge() {
    if (!queueBadgeEl) return;
    queueBadgeEl.classList.remove("xmem-queue-visible");
  }

  private flashError() {
    this.ensureBadge();
    queueBadgeEl!.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/>
        <line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
      <span>Sync failed — will retry next turn</span>
    `;
    queueBadgeEl!.classList.add("xmem-queue-visible", "xmem-queue-error");
    setTimeout(() => {
      queueBadgeEl?.classList.remove("xmem-queue-visible", "xmem-queue-error");
    }, 4000);
  }

  get length() {
    return this.queue.length;
  }

  get isProcessing() {
    return this.processing;
  }
}

const ingestionQueue = new IngestionQueue();

// ─── Save Conversation (non-blocking, queue-based) ───────────────────────

async function saveConversation() {
  const enabled = await new Promise<boolean>((resolve) => {
    if (!chrome?.storage?.sync) return resolve(false);
    chrome.storage.sync.get(["xmem_enabled"], (d) =>
      resolve(d.xmem_enabled !== false),
    );
  });
  if (!enabled) return;

  const editor = findEditor();
  const raw = savedInputText || (editor ? readEditorText(editor) : "");
  const cleaned = raw.replace(/<[^>]+>/g, "").trim();
  if (cleaned.length < 5) return;

  triggerSidecar(cleaned);

  if (xmemMode === "ingest") {
    showIngestQueued();
  }

  ingestionQueue.enqueue(cleaned);
  savedInputText = "";
}

async function captureLatestAgentResponse(): Promise<string> {
  // Basic wait for the AI to start generating
  await new Promise((r) => setTimeout(r, 2000));

  function getLatestNode() {
    const nodes = document.querySelectorAll<HTMLElement>(
      '[data-message-author-role="assistant"], .font-claude-message, model-response, .prose',
    );
    return nodes.length > 0 ? nodes[nodes.length - 1] : null;
  }

  let node = getLatestNode();
  if (!node) return "";
  let text = node.textContent?.trim() || "";

  // Wait until the text stops changing (streaming has completed)
  let stableCount = 0;
  const maxWaitLoops = 60; // Max 60 seconds of waiting
  for (let i = 0; i < maxWaitLoops; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    node = getLatestNode();
    const newText = node?.textContent?.trim() || "";
    if (newText === text && text.length > 0) {
      stableCount++;
      if (stableCount >= 2) break; // Stable for 2 consecutive seconds
    } else {
      stableCount = 0;
    }
    text = newText;
  }

  // Return full captured response
  return text;
}

// ─── Memory Sidecar ───────────────────────────────────────────────────────

let activeSidecar: HTMLElement | null = null;
let sidecarTarget: HTMLElement | null = null;
let currentSidecarQuery = "";

async function triggerSidecar(query: string) {
  // Only show sidecar in search mode
  if (xmemMode !== "search") return;

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
      '[data-message-author-role="assistant"], .font-claude-message, model-response, .prose',
    );
    if (nodes.length > 0) {
      // Find the last one (the most recent response)
      const last = nodes[nodes.length - 1];
      if (last.getBoundingClientRect().height > 0) return last;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function renderSidecar(target: HTMLElement, resp: RetrieveResult) {
  if (activeSidecar) activeSidecar.remove();
  sidecarTarget = target;

  activeSidecar = document.createElement("div");
  activeSidecar.className = `xmem-sidecar ${isDarkBackground(document.body) ? "xmem-dark-theme" : "xmem-light-theme"}`;

  const sourcesHtml = resp.sources?.length
    ? `<div class="xmem-sidecar-sources">${resp.sources.length} sources used</div>`
    : "";

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

  activeSidecar
    .querySelector(".xmem-sidecar-close")
    ?.addEventListener("click", () => {
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
    activeSidecar.style.display = "none";
    return;
  }
  activeSidecar.style.display = "flex";

  const spaceLeft = rect.left;

  // Position on the left side (since left is cleaner for ChatGPT/Claude)
  if (spaceLeft > 320) {
    activeSidecar.style.top = `${Math.max(80, rect.top)}px`;
    activeSidecar.style.left = `${Math.max(10, rect.left - 320)}px`;
    activeSidecar.style.width = "300px";
  } else {
    // If not enough space on left, try top-right corner of the bubble (overlapping safely)
    activeSidecar.style.top = `${Math.max(80, rect.top - 60)}px`;
    activeSidecar.style.left = `${Math.max(10, rect.right - 300)}px`;
    activeSidecar.style.width = "280px";
  }
}

// Keep sidecar anchored during scrolling or streaming text
window.addEventListener("scroll", updateSidecarPosition, true);
window.addEventListener("resize", updateSidecarPosition);
setInterval(updateSidecarPosition, 200);

// ─── Sidebar ──────────────────────────────────────────────────────────────

function createSidebar(): HTMLElement {
  if (sidebarEl && document.body.contains(sidebarEl)) return sidebarEl;

  sidebarEl = document.createElement("div");
  sidebarEl.id = "xmem-sidebar";
  sidebarEl.innerHTML = `
    <div class="xmem-sb-header">
      <div class="xmem-sb-logo">
        <div class="xmem-sb-logo-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a7 7 0 0 1 7 7c0 3-2 5.5-4 7l-3 3.5L9 16c-2-1.5-4-4-4-7a7 7 0 0 1 7-7z"/>
            <circle cx="12" cy="9" r="2"/>
          </svg>
        </div>
        <span>XMem</span>
      </div>
      <button class="xmem-sb-close-btn" id="xmem-sb-close" title="Close">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <div class="xmem-sb-controls">
      <div class="xmem-sb-segmented">
        <button class="xmem-sb-seg active" data-tab="memories">Memories</button>
        <button class="xmem-sb-seg" data-tab="ask">Ask</button>
        <div class="xmem-sb-seg-indicator"></div>
      </div>
    </div>

    <div class="xmem-sb-search-wrap">
      <div class="xmem-sb-search-bar">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input type="text" id="xmem-sb-search" placeholder="Search memories..." />
      </div>
    </div>

    <div class="xmem-sb-meta" id="xmem-sb-meta"></div>

    <div class="xmem-sb-content" id="xmem-sb-content">
      <div class="xmem-sb-panel active" id="xmem-panel-memories"></div>
      <div class="xmem-sb-panel" id="xmem-panel-ask">
        <div class="xmem-ask-container">
          <div class="xmem-ask-label">Ask your memories anything</div>
          <textarea id="xmem-ask-input" placeholder="e.g. What's my work experience?" rows="3"></textarea>
          <button class="xmem-ask-btn" id="xmem-ask-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
            Ask XMem
          </button>
          <div id="xmem-ask-result" class="xmem-ask-result"></div>
        </div>
      </div>
    </div>

    <div class="xmem-sb-footer">
      <div class="xmem-sb-footer-inner">
        <span class="xmem-sb-footer-text">XMem v1.0</span>
        <div class="xmem-sb-kbd"><kbd>⌃</kbd><kbd>⇧</kbd><kbd>M</kbd></div>
      </div>
    </div>
  `;

  document.body.appendChild(sidebarEl);
  setupSidebarEvents(sidebarEl);
  return sidebarEl;
}

function setupSidebarEvents(sidebar: HTMLElement) {
  sidebar
    .querySelector("#xmem-sb-close")
    ?.addEventListener("click", () => toggleSidebar());

  // Segmented control
  const segs = sidebar.querySelectorAll<HTMLElement>(".xmem-sb-seg");
  const indicator = sidebar.querySelector<HTMLElement>(
    ".xmem-sb-seg-indicator",
  );
  segs.forEach((seg, idx) => {
    seg.addEventListener("click", () => {
      segs.forEach((s) => s.classList.remove("active"));
      sidebar
        .querySelectorAll(".xmem-sb-panel")
        .forEach((p) => p.classList.remove("active"));
      seg.classList.add("active");
      sidebar
        .querySelector(`#xmem-panel-${seg.dataset.tab}`)
        ?.classList.add("active");
      // Move indicator
      if (indicator) {
        indicator.style.transform = `translateX(${idx * 100}%)`;
      }
      // Show/hide search bar based on tab
      const searchWrap = sidebar.querySelector<HTMLElement>(
        ".xmem-sb-search-wrap",
      );
      const metaEl = sidebar.querySelector<HTMLElement>(".xmem-sb-meta");
      if (seg.dataset.tab === "ask") {
        if (searchWrap) searchWrap.style.display = "none";
        if (metaEl) metaEl.style.display = "none";
      } else {
        if (searchWrap) searchWrap.style.display = "block";
        if (metaEl) metaEl.style.display = "block";
      }
    });
  });

  const searchInput = sidebar.querySelector(
    "#xmem-sb-search",
  ) as HTMLInputElement;
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  searchInput?.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();

    // Instant local text filtering on every keystroke
    if (q.length === 0) {
      renderMemories(cachedResults);
      return;
    }

    // Filter cached results: matching items first, then non-matching items hidden
    const filtered = cachedResults.filter(
      (m) =>
        m.content.toLowerCase().includes(q) ||
        m.domain.toLowerCase().includes(q),
    );
    renderMemories(filtered);

    // Also trigger API semantic search for longer queries (debounced)
    if (q.length >= 3) {
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(
        () => doManualSearch(searchInput.value.trim(), q),
        400,
      );
    }
  });

  sidebar
    .querySelector("#xmem-sb-save")
    ?.addEventListener("click", async () => {
      const editor = findEditor();
      if (!editor) return;
      const text = readEditorText(editor).trim();
      if (!text) return;
      try {
        await ingestMemory(text, "", xmemEffortLevel);
        showToast("Memory saved!");
      } catch {
        showToast("Failed to save memory", true);
      }
    });

  sidebar
    .querySelector("#xmem-ask-btn")
    ?.addEventListener("click", async () => {
      const input = sidebar.querySelector(
        "#xmem-ask-input",
      ) as HTMLTextAreaElement;
      const resultDiv = sidebar.querySelector(
        "#xmem-ask-result",
      ) as HTMLElement;
      const query = input?.value.trim();
      if (!query) return;

      resultDiv.innerHTML = '<div class="xmem-loader"></div>';
      try {
        const resp = await retrieveAnswer(query);
        resultDiv.innerHTML = `
        <div class="xmem-answer">
          <div class="xmem-answer-text">${escapeHtml(resp.answer || "No answer generated.")}</div>
          ${
            resp.sources?.length
              ? `
            <div class="xmem-answer-sources">
              <span class="xmem-answer-sources-label">${resp.sources.length} source${resp.sources.length > 1 ? "s" : ""}</span>
              ${resp.sources
                .map(
                  (s: SourceRecord) => `
                <div class="xmem-source-item">
                  <span class="xmem-domain-tag xmem-domain-${s.domain}">${s.domain}</span>
                  <span>${escapeHtml(s.content.substring(0, 100))}</span>
                </div>
              `,
                )
                .join("")}
            </div>
          `
              : ""
          }
        </div>
      `;
      } catch {
        resultDiv.innerHTML =
          '<div class="xmem-error">Failed to retrieve answer. Check connection.</div>';
      }
    });

  sidebar.addEventListener("click", (e) => e.stopPropagation());
}

async function doManualSearch(query: string, localFilter?: string) {
  try {
    const results = await searchMemories(query, { topK: 15 });
    // Merge new API results into cache (add any that weren't already there)
    const existingContents = new Set(cachedResults.map((m) => m.content));
    for (const r of results) {
      if (!existingContents.has(r.content)) cachedResults.push(r);
    }
    // If there's an active local filter, apply it before rendering
    if (localFilter) {
      const lf = localFilter.toLowerCase();
      const filtered = cachedResults.filter(
        (m) =>
          m.content.toLowerCase().includes(lf) ||
          m.domain.toLowerCase().includes(lf),
      );
      renderMemories(filtered);
    } else {
      renderMemories(results);
    }
  } catch {
    /* keep current view on error */
  }
}

function toggleSidebar() {
  const sidebar = createSidebar();
  sidebarOpen = !sidebarOpen;
  sidebar.classList.toggle("xmem-sb-open", sidebarOpen);
  if (sidebarOpen) {
    renderMemories(cachedResults);
    document.addEventListener("click", outsideClickHandler);
    document.addEventListener("keydown", sidebarEscHandler);
  } else {
    document.removeEventListener("click", outsideClickHandler);
    document.removeEventListener("keydown", sidebarEscHandler);
  }
}

function outsideClickHandler(e: MouseEvent) {
  if (sidebarEl && !sidebarEl.contains(e.target as Node)) {
    if (sidebarOpen) toggleSidebar();
  }
}

function sidebarEscHandler(e: KeyboardEvent) {
  if (e.key === "Escape" && sidebarOpen) toggleSidebar();
}

function updateMemoryMeta(count: number) {
  const el = document.getElementById("xmem-sb-meta");
  if (!el) return;
  if (count === 0) {
    el.innerHTML = "";
  } else {
    el.innerHTML = `<span class="xmem-meta-count">${count} ${count === 1 ? "memory" : "memories"}</span>`;
  }
}

function renderMemories(memories: SourceRecord[]) {
  const panel = document.getElementById("xmem-panel-memories");
  if (!panel) return;

  updateMemoryMeta(memories.length);

  if (memories.length === 0) {
    panel.innerHTML = `
      <div class="xmem-empty">
        <div class="xmem-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a7 7 0 0 1 7 7c0 3-2 5.5-4 7l-3 3.5L9 16c-2-1.5-4-4-4-7a7 7 0 0 1 7-7z"/>
            <circle cx="12" cy="9" r="2.5"/>
          </svg>
        </div>
        <p>No memories yet</p>
        <span>Start a conversation and XMem will<br>automatically learn from it</span>
      </div>
    `;
    updateMemoryMeta(0);
    return;
  }

  updateMemoryMeta(memories.length);

  const domainColors: Record<string, string> = {
    profile: "#a78bfa",
    temporal: "#60a5fa",
    summary: "#4ade80",
  };

  panel.innerHTML = memories
    .map((m, i) => {
      const color = domainColors[m.domain] || "#a78bfa";
      const scorePercent = (m.score * 100).toFixed(0);
      return `
    <div class="xmem-memory-card" data-idx="${i}" style="--domain-color: ${color}">
      <div class="xmem-memory-top">
        <div class="xmem-memory-domain">
          <span class="xmem-domain-dot" style="background: ${color}"></span>
          <span class="xmem-domain-label">${m.domain}</span>
        </div>
        <span class="xmem-score">${scorePercent}%</span>
      </div>
      <div class="xmem-memory-text">${escapeHtml(m.content)}</div>
      <div class="xmem-memory-actions">
        <button class="xmem-action-btn xmem-copy-btn" data-idx="${i}" title="Copy">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
          </svg>
          Copy
        </button>
        <button class="xmem-action-btn xmem-inject-btn" data-idx="${i}" title="Add to prompt">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Use
        </button>
      </div>
    </div>`;
    })
    .join("");

  panel.querySelectorAll<HTMLElement>(".xmem-copy-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx || "0", 10);
      const mem = memories[idx];
      if (mem) {
        navigator.clipboard.writeText(mem.content).then(() => {
          btn.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
          setTimeout(() => {
            btn.innerHTML =
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
          }, 1500);
        });
      }
    });
  });

  panel.querySelectorAll<HTMLElement>(".xmem-inject-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx || "0", 10);
      const mem = memories[idx];
      if (mem) {
        const editor = findEditor();
        if (editor) {
          insertTextIntoEditor(
            editor,
            `\n\n[XMem/${mem.domain}] ${mem.content}`,
          );
          showToast("Memory added to prompt");
        }
      }
    });
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────

function showToast(msg: string, isError = false) {
  document.getElementById("xmem-toast")?.remove();
  const toast = document.createElement("div");
  toast.id = "xmem-toast";
  const lightMode = !isDarkBackground(document.body);
  toast.className = `${isError ? "xmem-toast-error" : "xmem-toast-success"}${lightMode ? " xmem-toast-light" : ""}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("xmem-toast-visible"));
  setTimeout(() => {
    toast.classList.remove("xmem-toast-visible");
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ─── Utilities ────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

/**
 * Lightweight markdown renderer for code agent responses.
 * Handles: headings, bold, inline code, code blocks, bullet lists, numbered lists, line breaks.
 */
function renderMarkdown(md: string): string {
  // Normalize line endings
  let html = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Fenced code blocks  ```lang\n...\n```
  html = html.replace(/```[\w]*\n([\s\S]*?)```/g, (_m, code) => {
    const escaped = escapeHtml(code.trimEnd());
    return `<pre class="xmem-md-pre"><code>${escaped}</code></pre>`;
  });

  // Inline code `...`
  html = html.replace(
    /`([^`]+)`/g,
    (_m, code) => `<code class="xmem-md-code">${escapeHtml(code)}</code>`,
  );

  // ### Headings
  html = html.replace(/^### (.+)$/gm, '<h4 class="xmem-md-h">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 class="xmem-md-h">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 class="xmem-md-h">$1</h2>');

  // **bold**
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // *italic*
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // Process lines for lists and paragraphs
  const lines = html.split("\n");
  const out: string[] = [];
  let inUl = false;
  let inOl = false;

  for (const line of lines) {
    const ulMatch = line.match(/^[\*\-] (.+)/);
    const olMatch = line.match(/^\d+\. (.+)/);
    const isBlank = line.trim() === "";
    const isBlock = line.startsWith("<h") || line.startsWith("<pre");

    if (ulMatch) {
      if (!inUl) {
        if (inOl) {
          out.push("</ol>");
          inOl = false;
        }
        out.push('<ul class="xmem-md-ul">');
        inUl = true;
      }
      out.push(`<li>${ulMatch[1]}</li>`);
    } else if (olMatch) {
      if (!inOl) {
        if (inUl) {
          out.push("</ul>");
          inUl = false;
        }
        out.push('<ol class="xmem-md-ol">');
        inOl = true;
      }
      out.push(`<li>${olMatch[1]}</li>`);
    } else {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      if (isBlank) {
        out.push("<br>");
      } else if (isBlock) {
        out.push(line);
      } else {
        out.push(`<p class="xmem-md-p">${line}</p>`);
      }
    }
  }
  if (inUl) out.push("</ul>");
  if (inOl) out.push("</ol>");

  return out.join("");
}

// ─── Styles ───────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById("xmem-styles")) return;
  const style = document.createElement("style");
  style.id = "xmem-styles";
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
    .xmem-toast-success { background: rgba(161,161,170,0.06); color: #d4d4d8; border: 1px solid rgba(161,161,170,0.15); }
    .xmem-toast-error { background: #ef444420; color: #f87171; border: 1px solid #ef444440; }
    .xmem-toast-light.xmem-toast-success { background: #ffffff; color: #27272a; border: 1px solid #e4e4e7; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
    .xmem-toast-light.xmem-toast-error { background: #fff5f5; color: #dc2626; border: 1px solid #fecaca; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }

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


    /* ═══ Sidebar ═══ */
    #xmem-sidebar {
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      position: fixed; top: 0; right: -420px; width: 400px; height: 100vh;
      background: #0a0a0c;
      border-left: 1px solid rgba(255, 255, 255, 0.06);
      z-index: 2147483647;
      display: flex; flex-direction: column;
      transition: right 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: -12px 0 50px rgba(0,0,0,0.6);
      color: #e4e4e7;
    }
    #xmem-sidebar.xmem-sb-open { right: 0; }

    /* Header */
    .xmem-sb-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      flex-shrink: 0;
    }
    .xmem-sb-logo {
      display: flex; align-items: center; gap: 10px;
      font-size: 15px; font-weight: 700; color: #fff;
      letter-spacing: -0.3px;
    }
    .xmem-sb-logo-icon {
      width: 30px; height: 30px;
      background: linear-gradient(135deg, #7c3aed, #6366f1);
      border-radius: 8px; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 10px rgba(124, 58, 237, 0.25);
    }
    .xmem-sb-close-btn {
      background: none; border: none; color: #52525b; cursor: pointer;
      padding: 4px; border-radius: 6px; display: flex; align-items: center;
      transition: all 0.2s;
    }
    .xmem-sb-close-btn:hover { color: #a1a1aa; background: rgba(255,255,255,0.05); }

    /* Segmented Control */
    .xmem-sb-controls {
      padding: 12px 20px;
      flex-shrink: 0;
    }
    .xmem-sb-segmented {
      display: flex;
      position: relative;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 10px;
      padding: 3px;
    }
    .xmem-sb-seg-indicator {
      position: absolute; top: 3px; left: 3px;
      width: calc(50% - 3px); height: calc(100% - 6px);
      background: rgba(124, 58, 237, 0.2);
      border: 1px solid rgba(124, 58, 237, 0.3);
      border-radius: 8px;
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 0;
    }
    .xmem-sb-seg {
      flex: 1; padding: 8px 0; border: none; background: none;
      color: #71717a; font-size: 13px; font-weight: 600; cursor: pointer;
      text-align: center; position: relative; z-index: 1;
      transition: color 0.25s; letter-spacing: 0.2px;
    }
    .xmem-sb-seg:hover { color: #a1a1aa; }
    .xmem-sb-seg.active { color: #c4b5fd; }

    /* Search */
    .xmem-sb-search-wrap {
      padding: 0 20px 12px;
      flex-shrink: 0;
    }
    .xmem-sb-search-bar {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 10px;
      color: #52525b;
      transition: all 0.3s;
    }
    .xmem-sb-search-bar:focus-within {
      border-color: rgba(124, 58, 237, 0.4);
      background: rgba(124, 58, 237, 0.04);
      color: #a78bfa;
      box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.08);
    }
    .xmem-sb-search-bar input {
      flex: 1; background: none; border: none; outline: none;
      color: #e4e4e7; font-size: 13px; font-weight: 400;
    }
    .xmem-sb-search-bar input::placeholder { color: #3f3f46; }

    /* Meta (memory count) */
    .xmem-sb-meta {
      padding: 0 20px 8px; flex-shrink: 0;
    }
    .xmem-meta-count {
      font-size: 11px; color: #52525b; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.8px;
    }

    /* Content area */
    .xmem-sb-content {
      flex: 1; overflow-y: auto;
      scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.06) transparent;
    }
    .xmem-sb-content::-webkit-scrollbar { width: 4px; }
    .xmem-sb-content::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.06); border-radius: 4px; }
    .xmem-sb-content::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.12); }

    .xmem-sb-panel { display: none; padding: 0 20px 16px; }
    .xmem-sb-panel.active { display: block; animation: xmem-fade-in 0.3s ease; }
    @keyframes xmem-fade-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

    /* Memory Cards — Left-border accent */
    .xmem-memory-card {
      position: relative;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-left: 3px solid var(--domain-color, #a78bfa);
      border-radius: 10px;
      padding: 14px 14px 14px 16px;
      margin-bottom: 8px;
      transition: all 0.2s ease;
    }
    .xmem-memory-card:hover {
      background: rgba(255, 255, 255, 0.04);
      border-color: rgba(255, 255, 255, 0.08);
      border-left-color: var(--domain-color, #a78bfa);
    }
    .xmem-memory-top {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 8px;
    }
    .xmem-memory-domain {
      display: flex; align-items: center; gap: 6px;
    }
    .xmem-domain-dot {
      width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
    }
    .xmem-domain-label {
      font-size: 11px; font-weight: 600; color: #71717a;
      text-transform: uppercase; letter-spacing: 0.6px;
    }
    .xmem-score {
      font-size: 11px; color: #3f3f46; font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .xmem-memory-text {
      font-size: 13px; line-height: 1.55; color: #d4d4d8;
      word-break: break-word; font-weight: 400;
    }
    .xmem-memory-actions {
      display: flex; gap: 6px; margin-top: 10px;
      opacity: 0; transition: opacity 0.2s;
    }
    .xmem-memory-card:hover .xmem-memory-actions { opacity: 1; }
    .xmem-action-btn {
      background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 6px; color: #71717a; cursor: pointer;
      padding: 4px 10px; display: flex; align-items: center; gap: 4px;
      font-size: 11px; font-weight: 500; transition: all 0.15s;
    }
    .xmem-action-btn:hover { background: rgba(124, 58, 237, 0.12); color: #c4b5fd; border-color: rgba(124, 58, 237, 0.25); }

    /* Empty State */
    .xmem-empty {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; padding: 60px 24px; text-align: center; gap: 8px;
    }
    .xmem-empty-icon { color: #27272a; margin-bottom: 4px; }
    .xmem-empty p { color: #71717a; font-size: 14px; font-weight: 600; margin: 0; }
    .xmem-empty span { color: #3f3f46; font-size: 12px; line-height: 1.5; }

    /* Ask Tab */
    .xmem-ask-container { display: flex; flex-direction: column; gap: 12px; padding-top: 4px; }
    .xmem-ask-label { font-size: 12px; font-weight: 600; color: #52525b; text-transform: uppercase; letter-spacing: 0.8px; }
    .xmem-ask-container textarea {
      width: 100%;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 10px;
      color: #e4e4e7; padding: 12px 14px; font-size: 13px;
      resize: vertical; font-family: inherit;
      transition: all 0.25s; line-height: 1.5;
    }
    .xmem-ask-container textarea:focus {
      outline: none; border-color: rgba(124, 58, 237, 0.4);
      box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.08);
    }
    .xmem-ask-container textarea::placeholder { color: #3f3f46; }
    .xmem-ask-btn {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      background: #7c3aed; color: white;
      border: none; border-radius: 10px; padding: 10px 20px;
      font-size: 13px; font-weight: 600; cursor: pointer;
      transition: all 0.2s; letter-spacing: 0.2px;
    }
    .xmem-ask-btn:hover { background: #6d28d9; transform: translateY(-1px); box-shadow: 0 4px 14px rgba(124, 58, 237, 0.3); }
    .xmem-ask-btn:active { transform: scale(0.98); }
    .xmem-ask-result { min-height: 24px; }
    .xmem-answer {
      padding: 16px; background: rgba(255, 255, 255, 0.015);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-left: 2px solid rgba(161,161,170,0.25);
      border-radius: 6px;
      animation: xmem-fade-in 0.3s ease;
    }
    .xmem-answer-text { font-size: 13px; line-height: 1.7; color: #c4c4cc; }
    .xmem-answer-sources { margin-top: 14px; border-top: 1px solid rgba(255,255,255,0.04); padding-top: 10px; }
    .xmem-answer-sources-label { font-size: 10px; color: #3f3f46; font-weight: 500; text-transform: uppercase; letter-spacing: 0.8px; font-style: italic; }
    .xmem-source-item {
      display: flex; align-items: flex-start; gap: 6px;
      margin-top: 6px; font-size: 12px; color: #52525b;
    }
    .xmem-error { color: #a1a1aa; font-size: 12px; padding: 14px; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 5px; font-style: italic; }

    /* Footer */
    .xmem-sb-footer {
      padding: 10px 20px; border-top: 1px solid rgba(255, 255, 255, 0.04);
      flex-shrink: 0;
    }
    .xmem-sb-footer-inner {
      display: flex; justify-content: space-between; align-items: center;
    }
    .xmem-sb-footer-text { font-size: 11px; color: #27272a; font-weight: 500; }
    .xmem-sb-kbd { display: flex; gap: 3px; }
    .xmem-sb-kbd kbd {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 20px; height: 20px; padding: 0 5px;
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
      border-radius: 4px; font-size: 11px; font-weight: 600; color: #3f3f46;
      font-family: inherit;
    }

    .xmem-loader {
      width: 18px; height: 18px; border: 1.5px solid rgba(255,255,255,0.06);
      border-top-color: #71717a; border-radius: 50%;
      animation: xmem-spin 0.8s linear infinite;
      margin: 20px auto;
    }
    @keyframes xmem-spin { to { transform: rotate(360deg); } }

    /* ═══ Context Injection Overlay ═══ */
    .xmem-inject-overlay {
      position: fixed;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      z-index: 2147483647;
      pointer-events: none;
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      font-size: 12px;
      font-style: italic;
      color: #71717a;
      letter-spacing: 0.2px;
      animation: xmem-fade-in 0.15s ease;
      white-space: nowrap;
    }
    .xmem-inject-overlay .xmem-inject-dot {
      width: 3.5px; height: 3.5px;
      border-radius: 50%;
      background: #71717a;
      animation: xmem-inject-pulse 1.2s ease-in-out infinite;
    }
    .xmem-inject-overlay .xmem-inject-dot:nth-child(2) { animation-delay: 0.2s; }
    .xmem-inject-overlay .xmem-inject-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes xmem-inject-pulse {
      0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
      40% { opacity: 1; transform: scale(1.1); }
    }
    .xmem-inject-overlay.xmem-inject-light {
      color: #a1a1aa;
    }
    .xmem-inject-overlay.xmem-inject-light .xmem-inject-dot {
      background: #a1a1aa;
    }

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

    /* ═══ Slash Command Dropdown ═══ */
    #xmem-slash-dropdown {
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: none;
      background: #141416;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 4px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.45), 0 1px 3px rgba(0,0,0,0.2);
      min-width: 240px;
      animation: xmem-fade-in 0.15s ease;
      backdrop-filter: blur(16px);
    }
    .xmem-slash-option {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 9px 12px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.12s ease;
    }
    .xmem-slash-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .xmem-slash-option:hover,
    .xmem-slash-option.xmem-slash-selected {
      background: rgba(255,255,255,0.055);
    }
    .xmem-slash-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px; height: 26px;
      border-radius: 5px;
      background: rgba(255,255,255,0.04);
      color: #a1a1aa;
      flex-shrink: 0;
    }
    .xmem-slash-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .xmem-slash-cmd {
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace;
      font-size: 12.5px;
      font-weight: 500;
      letter-spacing: 0.3px;
      color: #e4e4e7;
    }
    .xmem-slash-desc {
      font-size: 11px;
      font-style: italic;
      color: #63636e;
      letter-spacing: 0.1px;
    }

    /* ═══ Slash Dropdown — Light Theme ═══ */
    #xmem-slash-dropdown.xmem-slash-light {
      background: #ffffff;
      border-color: #e4e4e7;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05);
    }
    .xmem-slash-light .xmem-slash-option:hover,
    .xmem-slash-light .xmem-slash-option.xmem-slash-selected {
      background: rgba(0,0,0,0.04);
    }
    .xmem-slash-light .xmem-slash-icon {
      background: #f4f4f5;
      color: #71717a;
    }
    .xmem-slash-light .xmem-slash-cmd { color: #27272a; }
    .xmem-slash-light .xmem-slash-desc { color: #a1a1aa; }

    /* ═══ Effort Toggle (inside slash dropdown) ═══ */
    .xmem-effort-high-warn {
      color: #fb923c !important;
      font-weight: 500;
    }
    
    .xmem-slash-right {
      display: flex;
      align-items: center;
    }

    .xmem-switch-btn {
      position: relative;
      width: 28px;
      height: 16px;
      border-radius: 10px;
      background: rgba(255,255,255,0.15);
      border: none;
      cursor: pointer;
      padding: 0;
      transition: background 0.2s ease;
    }
    .xmem-switch-btn.xmem-switch-on {
      background: #fb923c;
    }
    .xmem-switch-knob {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 12px;
      height: 12px;
      background: #fff;
      border-radius: 50%;
      transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    .xmem-switch-btn.xmem-switch-on .xmem-switch-knob {
      transform: translateX(12px);
    }

    /* ── Effort Toggle Light Theme ── */
    .xmem-slash-light .xmem-effort-high-warn {
      color: #ea580c !important;
    }
    .xmem-slash-light .xmem-switch-btn {
      background: #d4d4d8;
    }
    .xmem-slash-light .xmem-switch-btn.xmem-switch-on {
      background: #ea580c;
    }

    /* ═══ IDE Panel ═══ */
    #xmem-ide-panel {
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      position: fixed;
      top: 0; right: 0;
      width: 360px; height: 100vh;
      background: #111113;
      border-left: 1px solid rgba(255,255,255,0.07);
      z-index: 2147483646;
      display: flex;
      flex-direction: column;
      box-shadow: -4px 0 32px rgba(0,0,0,0.45);
      color: #d4d4d8;
      animation: xmem-slide-in 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .xmem-ide-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 18px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    }
    .xmem-ide-logo {
      display: flex; align-items: center; gap: 10px;
      font-size: 13px; font-weight: 500; color: #a1a1aa;
      letter-spacing: 0.3px;
    }
    .xmem-ide-logo-icon {
      width: 24px; height: 24px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
    }
    .xmem-ide-logo span {
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace;
      font-style: italic;
      font-weight: 500;
      color: #e4e4e7;
      font-size: 13px;
    }
    .xmem-ide-close-btn {
      background: none; border: none; color: #3f3f46;
      cursor: pointer; padding: 5px; border-radius: 5px;
      display: flex; align-items: center; transition: all 0.15s;
    }
    .xmem-ide-close-btn:hover { color: #71717a; background: rgba(255,255,255,0.04); }

    .xmem-ide-config {
      padding: 14px 18px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      display: flex;
      flex-direction: column;
      gap: 10px;
      flex-shrink: 0;
    }
    .xmem-ide-field label {
      display: block;
      font-size: 10px; font-weight: 500; color: #8b8b95;
      text-transform: uppercase; letter-spacing: 0.8px;
      margin-bottom: 5px;
      font-style: italic;
    }
    .xmem-ide-field input {
      width: 100%;
      background: rgba(255,255,255,0.025);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 5px;
      color: #d4d4d8;
      padding: 8px 11px;
      font-size: 12px;
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
      transition: border-color 0.15s;
    }
    .xmem-ide-field input:focus {
      outline: none;
      border-color: rgba(161,161,170,0.3);
    }
    .xmem-ide-field input::placeholder { color: #52525b; }
    .xmem-ide-load-btn {
      background: rgba(255,255,255,0.07);
      color: #d4d4d8;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 5px;
      padding: 8px 16px;
      font-size: 11.5px; font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
      letter-spacing: 0.2px;
    }
    .xmem-ide-load-btn:hover {
      background: rgba(255,255,255,0.1);
      border-color: rgba(255,255,255,0.15);
    }

    .xmem-ide-tree-container {
      flex: 1;
      overflow-y: auto;
      padding: 6px 0;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.05) transparent;
    }
    .xmem-ide-tree-container::-webkit-scrollbar { width: 3px; }
    .xmem-ide-tree-container::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.06); border-radius: 3px; }
    .xmem-ide-empty {
      text-align: center;
      padding: 48px 24px;
      color: #71717a;
      font-size: 12px;
      font-style: italic;
    }

    /* Directory tree nodes */
    .xmem-tree-dir-header {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      cursor: pointer;
      border-radius: 3px;
      transition: background 0.1s;
      user-select: none;
    }
    .xmem-tree-dir-header:hover { background: rgba(255,255,255,0.035); }
    .xmem-tree-arrow {
      width: 14px; height: 14px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 9px; color: #71717a;
      transition: transform 0.15s;
      flex-shrink: 0;
    }
    .xmem-tree-arrow::before { content: '\\25B8'; }
    .xmem-tree-open > .xmem-tree-dir-header .xmem-tree-arrow { transform: rotate(90deg); color: #a1a1aa; }
    .xmem-tree-children { display: none; }
    .xmem-tree-open > .xmem-tree-children { display: block; }

    .xmem-tree-folder-icon {
      width: 14px; height: 14px;
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      color: #52525b;
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
      font-size: 10px;
      font-weight: 500;
    }
    .xmem-tree-folder-icon::before {
      content: '/';
      color: #71717a;
    }
    .xmem-tree-open > .xmem-tree-dir-header .xmem-tree-folder-icon::before {
      content: '/';
      color: #a1a1aa;
    }

    .xmem-tree-file {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 3px 10px;
      border-radius: 3px;
      transition: background 0.1s;
      cursor: default;
    }
    .xmem-tree-file:hover { background: rgba(255,255,255,0.025); }
    .xmem-tree-name {
      font-size: 12px;
      color: #a1a1aa;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
      font-size: 11.5px;
    }
    .xmem-tree-dir-header .xmem-tree-name {
      color: #d4d4d8; font-weight: 500;
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
      font-size: 11.5px;
    }

    .xmem-tree-icon {
      width: 14px; height: 14px;
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      font-size: 10px;
      border-radius: 2px;
    }
    .xmem-icon-file::before { content: '~'; font-size: 11px; color: #71717a; font-family: 'SF Mono', monospace; }
    .xmem-icon-py::before { content: 'py'; font-size: 7.5px; font-weight: 600; color: #8b8b95; font-family: 'SF Mono', monospace; }
    .xmem-icon-ts::before { content: 'ts'; font-size: 7.5px; font-weight: 600; color: #8b8b95; font-family: 'SF Mono', monospace; }
    .xmem-icon-js::before { content: 'js'; font-size: 7.5px; font-weight: 600; color: #8b8b95; font-family: 'SF Mono', monospace; }
    .xmem-icon-json::before { content: '{}'; font-size: 8px; font-weight: 600; color: #71717a; font-family: 'SF Mono', monospace; }
    .xmem-icon-md::before { content: 'md'; font-size: 7.5px; font-weight: 600; color: #71717a; font-family: 'SF Mono', monospace; }
    .xmem-icon-css::before { content: 'cs'; font-size: 7.5px; font-weight: 600; color: #8b8b95; font-family: 'SF Mono', monospace; }
    .xmem-icon-html::before { content: 'ht'; font-size: 7.5px; font-weight: 600; color: #8b8b95; font-family: 'SF Mono', monospace; }
    .xmem-icon-yaml::before { content: 'ym'; font-size: 7.5px; font-weight: 600; color: #71717a; font-family: 'SF Mono', monospace; }
    .xmem-icon-java::before { content: 'jv'; font-size: 7.5px; font-weight: 600; color: #8b8b95; font-family: 'SF Mono', monospace; }
    .xmem-icon-go::before { content: 'go'; font-size: 7.5px; font-weight: 600; color: #8b8b95; font-family: 'SF Mono', monospace; }
    .xmem-icon-rs::before { content: 'rs'; font-size: 7.5px; font-weight: 600; color: #8b8b95; font-family: 'SF Mono', monospace; }

    .xmem-ide-query-section {
      padding: 14px 18px;
      border-top: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .xmem-ide-query-label {
      font-size: 10px; font-weight: 500; color: #8b8b95;
      text-transform: uppercase; letter-spacing: 0.8px;
      margin-bottom: 8px;
      font-style: italic;
    }
    .xmem-ide-query-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 9px 12px;
      background: rgba(255,255,255,0.025);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 5px;
      color: #3f3f46;
      transition: border-color 0.15s;
    }
    .xmem-ide-query-bar:focus-within {
      border-color: rgba(161,161,170,0.25);
      color: #71717a;
    }
    .xmem-ide-query-bar input {
      flex: 1; background: none; border: none; outline: none;
      color: #d4d4d8; font-size: 12px;
    }
    .xmem-ide-query-bar input::placeholder { color: #52525b; }
    .xmem-ide-query-result {
      margin-top: 10px;
      max-height: 45vh;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.05) transparent;
    }
    .xmem-ide-query-result::-webkit-scrollbar { width: 3px; }
    .xmem-ide-query-result::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.06); border-radius: 3px; }

    /* ═══ IDE Panel — Light Theme ═══ */
    #xmem-ide-panel.xmem-ide-light {
      background: #fafafa;
      border-left: 1px solid #e4e4e7;
      box-shadow: -4px 0 32px rgba(0,0,0,0.08);
      color: #27272a;
    }
    .xmem-ide-light .xmem-ide-header {
      border-bottom: 1px solid #e4e4e7;
    }
    .xmem-ide-light .xmem-ide-logo {
      color: #71717a;
    }
    .xmem-ide-light .xmem-ide-logo-icon {
      background: #f4f4f5;
      border-color: #d4d4d8;
    }
    .xmem-ide-light .xmem-ide-logo-icon svg { stroke: #71717a; }
    .xmem-ide-light .xmem-ide-logo span {
      color: #27272a;
    }
    .xmem-ide-light .xmem-ide-close-btn { color: #a1a1aa; }
    .xmem-ide-light .xmem-ide-close-btn:hover { color: #52525b; background: rgba(0,0,0,0.04); }

    .xmem-ide-light .xmem-ide-config {
      border-bottom-color: #e4e4e7;
    }
    .xmem-ide-light .xmem-ide-field label {
      color: #71717a;
    }
    .xmem-ide-light .xmem-ide-field input {
      background: #fff;
      border-color: #d4d4d8;
      color: #18181b;
    }
    .xmem-ide-light .xmem-ide-field input:focus {
      border-color: #a1a1aa;
    }
    .xmem-ide-light .xmem-ide-field input::placeholder { color: #a1a1aa; }
    .xmem-ide-light .xmem-ide-load-btn {
      background: #f4f4f5;
      color: #27272a;
      border-color: #d4d4d8;
    }
    .xmem-ide-light .xmem-ide-load-btn:hover {
      background: #e4e4e7;
      border-color: #a1a1aa;
    }

    .xmem-ide-light .xmem-ide-tree-container {
      scrollbar-color: rgba(0,0,0,0.08) transparent;
    }
    .xmem-ide-light .xmem-ide-tree-container::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.08); }
    .xmem-ide-light .xmem-ide-empty { color: #a1a1aa; }

    .xmem-ide-light .xmem-tree-dir-header:hover { background: rgba(0,0,0,0.03); }
    .xmem-ide-light .xmem-tree-arrow { color: #a1a1aa; }
    .xmem-ide-light .xmem-tree-open > .xmem-tree-dir-header .xmem-tree-arrow { color: #71717a; }
    .xmem-ide-light .xmem-tree-folder-icon::before { color: #a1a1aa; }
    .xmem-ide-light .xmem-tree-open > .xmem-tree-dir-header .xmem-tree-folder-icon::before { color: #71717a; }
    .xmem-ide-light .xmem-tree-file:hover { background: rgba(0,0,0,0.02); }
    .xmem-ide-light .xmem-tree-name { color: #52525b; }
    .xmem-ide-light .xmem-tree-dir-header .xmem-tree-name { color: #18181b; }

    .xmem-ide-light .xmem-icon-file::before { color: #a1a1aa; }
    .xmem-ide-light .xmem-icon-py::before,
    .xmem-ide-light .xmem-icon-ts::before,
    .xmem-ide-light .xmem-icon-js::before,
    .xmem-ide-light .xmem-icon-css::before,
    .xmem-ide-light .xmem-icon-html::before,
    .xmem-ide-light .xmem-icon-java::before,
    .xmem-ide-light .xmem-icon-go::before,
    .xmem-ide-light .xmem-icon-rs::before { color: #71717a; }
    .xmem-ide-light .xmem-icon-json::before,
    .xmem-ide-light .xmem-icon-md::before,
    .xmem-ide-light .xmem-icon-yaml::before { color: #a1a1aa; }

    .xmem-ide-light .xmem-ide-query-section {
      border-top-color: #e4e4e7;
    }
    .xmem-ide-light .xmem-ide-query-label { color: #71717a; }
    .xmem-ide-light .xmem-ide-query-bar {
      background: #fff;
      border-color: #d4d4d8;
      color: #a1a1aa;
    }
    .xmem-ide-light .xmem-ide-query-bar:focus-within {
      border-color: #71717a;
      color: #52525b;
    }
    .xmem-ide-light .xmem-ide-query-bar input { color: #18181b; }
    .xmem-ide-light .xmem-ide-query-bar input::placeholder { color: #a1a1aa; }
    .xmem-ide-light .xmem-ide-query-result {
      scrollbar-color: rgba(0,0,0,0.08) transparent;
    }
    .xmem-ide-light .xmem-ide-query-result::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.08); }

    .xmem-ide-light .xmem-answer {
      background: rgba(0,0,0,0.015);
      border-color: #e4e4e7;
      border-left-color: #a1a1aa;
    }
    .xmem-ide-light .xmem-answer-text { color: #27272a; }
    .xmem-ide-light .xmem-answer-sources { border-top-color: #e4e4e7; }
    .xmem-ide-light .xmem-answer-sources-label { color: #a1a1aa; }
    .xmem-ide-light .xmem-source-item { color: #71717a; }
    .xmem-ide-light .xmem-error {
      background: rgba(239,68,68,0.04);
      border-color: rgba(239,68,68,0.15);
      color: #dc2626;
    }
    .xmem-ide-light .xmem-loader {
      border-color: rgba(0,0,0,0.06);
      border-top-color: #71717a;
    }
    .xmem-ide-light .xmem-md-body { color: #27272a; }
    .xmem-ide-light .xmem-md-body .xmem-md-h { color: #18181b; }
    .xmem-ide-light .xmem-md-body .xmem-md-pre {
      background: #f4f4f5;
      border-color: #e4e4e7;
      color: #27272a;
    }
    .xmem-ide-light .xmem-md-body .xmem-md-code {
      background: #f4f4f5;
      border-color: #e4e4e7;
      color: #0969da;
    }

    /* ═══ Markdown Renderer ═══ */
    .xmem-md-body { font-size: 13px; line-height: 1.65; color: #d4d4d4; }
    .xmem-md-body .xmem-md-h { font-weight: 700; color: #fff; margin: 10px 0 4px; }
    .xmem-md-body h2.xmem-md-h { font-size: 15px; }
    .xmem-md-body h3.xmem-md-h { font-size: 14px; }
    .xmem-md-body h4.xmem-md-h { font-size: 13px; }
    .xmem-md-body .xmem-md-p { margin: 3px 0; }
    .xmem-md-body .xmem-md-ul,
    .xmem-md-body .xmem-md-ol { padding-left: 18px; margin: 4px 0; }
    .xmem-md-body li { margin: 2px 0; }
    .xmem-md-body .xmem-md-pre {
      background: #0d0d14;
      border: 1px solid #2a2a3d;
      border-radius: 6px;
      padding: 10px 12px;
      margin: 8px 0;
      overflow-x: auto;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #c9d1d9;
      white-space: pre;
    }
    .xmem-md-body .xmem-md-code {
      background: #1a1a2e;
      border: 1px solid #2a2a3d;
      border-radius: 3px;
      padding: 1px 5px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 11.5px;
      color: #79c0ff;
    }

    /* ═══ Ingest Status Banner ═══ */
    .xmem-ingest-status {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      z-index: 2147483647;
      opacity: 0;
      transition: opacity 0.3s, transform 0.3s;
      pointer-events: none;
      
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    }
    .xmem-ingest-status.xmem-status-visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .xmem-ingest-status.xmem-ingest-pending {
      background: rgba(161,161,170, 0.06);
      border: 1px solid rgba(161,161,170, 0.15);
      color: #a1a1aa;
    }
    .xmem-ingest-status.xmem-ingest-success {
      background: rgba(161,161,170, 0.06);
      border: 1px solid rgba(161,161,170, 0.15);
      color: #d4d4d8;
    }
    .xmem-ingest-status.xmem-ingest-error {
      background: rgba(161,161,170, 0.04);
      border: 1px solid rgba(239, 68, 68, 0.15);
      color: #ef4444;
    }
    .xmem-ingest-spinner {
      width: 12px; height: 12px;
      border: 1.5px solid rgba(161,161,170, 0.15);
      border-top-color: #71717a;
      border-radius: 50%;
      animation: xmem-spin 0.7s linear infinite;
      flex-shrink: 0;
    }

    /* ═══ Ingestion Queue Badge ═══ */
    .xmem-queue-badge {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 2147483646;
      opacity: 0;
      transform: translateY(8px);
      transition: opacity 0.3s ease, transform 0.3s ease;
      pointer-events: none;

      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      background: rgba(24, 24, 30, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(161,161,170, 0.12);
      color: #a1a1aa;
      box-shadow: 0 2px 12px rgba(0,0,0,0.3);
    }
    .xmem-queue-badge.xmem-queue-visible {
      opacity: 1;
      transform: translateY(0);
      pointer-events: auto;
    }
    .xmem-queue-badge.xmem-queue-error {
      border-color: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }
    .xmem-queue-spinner {
      width: 10px; height: 10px;
      border: 1.5px solid rgba(161,161,170, 0.15);
      border-top-color: #71717a;
      border-radius: 50%;
      animation: xmem-spin 0.7s linear infinite;
      flex-shrink: 0;
    }
  `;
  document.head.appendChild(style);
}

// ─── Highlight-to-Remember ────────────────────────────────────────────────

let highlightBtn: HTMLElement | null = null;
let currentSelectionText = "";

function setupHighlightToRemember() {
  document.addEventListener("mouseup", handleSelection);
  document.addEventListener("mousedown", (e) => {
    if (highlightBtn && highlightBtn.contains(e.target as Node)) {
      return;
    }
    dismissHighlightBtn();
  });

  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      dismissHighlightBtn();
    }
  });
}

function handleSelection(e: MouseEvent) {
  setTimeout(async () => {
    const enabled = await new Promise<boolean>((resolve) => {
      if (!chrome?.storage?.sync) return resolve(false);
      chrome.storage.sync.get(["xmem_enabled"], (d) =>
        resolve(d.xmem_enabled !== false),
      );
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

    if (
      activeSidecar?.contains(sel.anchorNode) ||
      sidebarEl?.contains(sel.anchorNode) ||
      highlightBtn?.contains(sel.anchorNode)
    ) {
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
    highlightBtn = document.createElement("div");
    highlightBtn.id = "xmem-highlight-btn";
    highlightBtn.innerHTML = `
      <div class="xmem-hl-icon">X</div>
      <span>Remember</span>
    `;

    highlightBtn.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });

    highlightBtn.addEventListener("click", async (ev) => {
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
        highlightBtn.classList.add("xmem-hl-success");
      }

      try {
        await ingestMemory(textToSave, "", xmemEffortLevel);
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

  highlightBtn.className = `xmem-highlight-btn ${isDarkBackground(document.body) ? "xmem-dark-theme" : "xmem-light-theme"}`;

  highlightBtn.style.top = `${top - 40}px`;
  highlightBtn.style.left = `${left}px`;
  highlightBtn.style.display = "flex";
}

function dismissHighlightBtn() {
  if (highlightBtn) {
    highlightBtn.style.display = "none";
    highlightBtn.classList.remove("xmem-hl-success");
    highlightBtn.innerHTML = `
      <div class="xmem-hl-icon">X</div>
      <span>Remember</span>
    `;
  }
  currentSelectionText = "";
}

// ─── Context Injection (IDE & Search modes) ──────────────────────────────

function replaceEditorText(editor: HTMLElement, text: string) {
  if (editor instanceof HTMLTextAreaElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (nativeSetter) nativeSetter.call(editor, text);
    else editor.value = text;
    editor.selectionStart = editor.selectionEnd = text.length;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    editor.focus();
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
  }
}

/**
 * Detects file paths and symbol names mentioned in a user query.
 * Files: anything ending in a known extension, or containing path separators.
 * Symbols: CamelCase classes, snake_case functions, or _private names.
 */
function extractCodeRefs(query: string): {
  files: string[];
  symbols: string[];
} {
  const files: string[] = [];
  const symbols: string[] = [];

  // File paths: word.ext or path/to/file.ext
  const fileRe =
    /(?:^|\s|["'`(])(([\w.\-/]+\/)*([\w\-]+\.(py|ts|tsx|js|jsx|go|rs|java|cpp|c|h|cs|rb|php|swift|kt|md|yaml|yml|json|toml|sh|env)))/gi;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(query)) !== null) {
    const f = m[1].trim();
    if (!files.includes(f)) files.push(f);
  }

  // Symbol names: CamelCase (classes), snake_case functions, _private names
  // But NOT common English words, so require at least one _ or mixed case
  const symRe =
    /\b([A-Z][a-zA-Z0-9]{2,}|[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}|_[a-z][a-z0-9_]+)\b/g;
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "from",
    "with",
    "this",
    "that",
    "have",
    "been",
    "will",
    "should",
    "could",
    "would",
    "does",
    "about",
    "like",
    "just",
    "also",
    "into",
    "over",
    "only",
    "then",
    "than",
    "make",
    "when",
    "what",
    "which",
    "how",
    "can",
    "its",
    "are",
    "you",
    "use",
    "but",
    "not",
    "any",
    "show",
    "give",
    "find",
    "get",
    "all",
    "fix",
    "see",
    "help",
    "error",
    "file",
    "code",
    "class",
    "function",
    "method",
    "test",
    "bug",
    "issue",
    "facing",
  ]);
  while ((m = symRe.exec(query)) !== null) {
    const sym = m[1];
    if (!stopWords.has(sym.toLowerCase()) && !symbols.includes(sym)) {
      symbols.push(sym);
    }
  }

  return { files, symbols };
}

function showInjectionOverlay(editor: HTMLElement, label: string): HTMLElement {
  const overlay = document.createElement("div");
  const isLight = !isDarkBackground(document.body);
  overlay.className = `xmem-inject-overlay${isLight ? " xmem-inject-light" : ""}`;
  overlay.innerHTML = `
    <span class="xmem-inject-dot"></span>
    <span class="xmem-inject-dot"></span>
    <span class="xmem-inject-dot"></span>
    <span style="margin-left: 2px">${label}</span>
  `;
  document.body.appendChild(overlay);

  const caret = getCaretXY(editor);
  if (caret) {
    overlay.style.left = `${caret.x + 4}px`;
    overlay.style.top = `${caret.y + (caret.h - 14) / 2}px`;
  } else {
    const rect = editor.getBoundingClientRect();
    const cs = getComputedStyle(editor);
    const textLen = (
      editor instanceof HTMLTextAreaElement
        ? editor.value
        : editor.textContent || ""
    ).length;
    overlay.style.left = `${rect.left + parseFloat(cs.paddingLeft) + Math.min(textLen * 7, rect.width * 0.6)}px`;
    overlay.style.top = `${rect.top + parseFloat(cs.paddingTop)}px`;
  }

  return overlay;
}

function removeInjectionOverlay(overlay: HTMLElement) {
  overlay.remove();
}

function fireBypassSend(editor: HTMLElement) {
  bypassContextInjection = true;
  const sendBtn = findSendButton();
  if (sendBtn) {
    sendBtn.click();
  } else {
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
}

const USER_MSG_SELECTORS = [
  '[data-message-author-role="user"]',
  ".font-user-message",
  "user-query",
  ".user-turn",
  "[data-is-user-message]",
  ".whitespace-pre-wrap",
];

const CONTEXT_TAG_RE =
  /<xmem_(?:code_context|memory_context)[^>]*>[\s\S]*?<\/xmem_(?:code_context|memory_context)>\s*/g;

function scrubContextFromLastUserMessage() {
  let attempts = 0;
  const maxAttempts = 25;

  const poll = () => {
    attempts++;
    for (const sel of USER_MSG_SELECTORS) {
      const nodes = document.querySelectorAll<HTMLElement>(sel);
      if (nodes.length === 0) continue;
      const last = nodes[nodes.length - 1];
      const text = last.textContent || "";
      if (CONTEXT_TAG_RE.test(text)) {
        CONTEXT_TAG_RE.lastIndex = 0;

        const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT);
        const textNodes: Text[] = [];
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null)) textNodes.push(node);

        const fullText = textNodes.map((n) => n.nodeValue).join("");
        if (!CONTEXT_TAG_RE.test(fullText)) {
          if (attempts < maxAttempts) setTimeout(poll, 200);
          CONTEXT_TAG_RE.lastIndex = 0;
          return;
        }
        CONTEXT_TAG_RE.lastIndex = 0;

        let accumulated = "";
        const tagStart = fullText.search(
          /<xmem_(?:code_context|memory_context)/,
        );
        const tagEndMatch = fullText.match(
          /<\/xmem_(?:code_context|memory_context)>\s*/,
        );
        if (
          tagStart === -1 ||
          !tagEndMatch ||
          tagEndMatch.index === undefined
        ) {
          if (attempts < maxAttempts) setTimeout(poll, 200);
          return;
        }
        const tagEnd = tagEndMatch.index + tagEndMatch[0].length;

        let pos = 0;
        for (const tn of textNodes) {
          const val = tn.nodeValue || "";
          const nodeStart = pos;
          const nodeEnd = pos + val.length;
          pos = nodeEnd;

          if (nodeEnd <= tagStart || nodeStart >= tagEnd) continue;

          const cutFrom = Math.max(0, tagStart - nodeStart);
          const cutTo = Math.min(val.length, tagEnd - nodeStart);
          tn.nodeValue = val.slice(0, cutFrom) + val.slice(cutTo);
        }
        return;
      }
    }
    if (attempts < maxAttempts) setTimeout(poll, 200);
  };

  setTimeout(poll, 300);
}

async function injectContextAndSend(editor: HTMLElement) {
  const userQuery = readEditorText(editor).trim();
  if (!userQuery || userQuery.length < 5) {
    fireBypassSend(editor);
    return;
  }

  if (xmemMode === "search") {
    const overlay = showInjectionOverlay(editor, "Recalling memories...");
    let contextText = "";
    try {
      const result = await retrieveAnswer(userQuery);
      contextText = result.answer || "";
    } catch (err) {
      console.error("[XMem] Memory fetch failed:", err);
    }

    if (contextText) {
      replaceEditorText(
        editor,
        `<xmem_memory_context>\n${contextText}\n</xmem_memory_context>\n\n${userQuery}`,
      );
    }
    await new Promise((r) => setTimeout(r, 80));
    fireBypassSend(editor);
    requestAnimationFrame(() => removeInjectionOverlay(overlay));
    if (contextText) scrubContextFromLastUserMessage();
    return;
  }

  // IDE mode
  if (!ideOrgId || !ideRepo) {
    showToast("Set up your repo first with Xrepo", true);
    fireBypassSend(editor);
    return;
  }

  const { files, symbols } = extractCodeRefs(userQuery);
  const hasRefs = files.length > 0 || symbols.length > 0;

  if (!hasRefs) {
    console.log(
      "[XMem] IDE: no file/symbol refs detected, sending without context",
    );
    fireBypassSend(editor);
    return;
  }

  const overlay = showInjectionOverlay(editor, "Fetching code context...");

  const fileList = files.map((f) => `  - file: "${f}"`).join("\n");
  const symList = symbols.map((s) => `  - symbol: "${s}"`).join("\n");

  const retrievalPrompt =
    `You are a code retrieval tool. The user's message references the following:\n` +
    (files.length ? `\nFILES:\n${fileList}` : "") +
    (symbols.length ? `\nSYMBOLS:\n${symList}` : "") +
    `\n\nFor EACH item above:\n` +
    `- For files: call read_file_code(file_path, repo) and return the COMPLETE raw source.\n` +
    `- For symbols: call read_symbol_code(symbol_name, file_path, repo) and return the COMPLETE raw source.\n` +
    `- Label each result clearly with the file/symbol name and its full path.\n` +
    `- Return ONLY the raw source code — no explanations, no analysis, no commentary.\n` +
    `- If multiple items are requested, include ALL of them.\n\n` +
    `User's message (DO NOT answer this — only fetch the code): "${userQuery}"`;

  let contextText = "";
  try {
    const result = await queryCode(ideOrgId, ideRepo, retrievalPrompt);
    contextText = result.answer || "";
  } catch (err) {
    console.error("[XMem] Code fetch failed:", err);
    showToast("Code fetch failed, sending without context", true);
  }

  if (contextText) {
    const enriched = `<xmem_code_context repo="${ideRepo}">\n${contextText}\n</xmem_code_context>\n\n${userQuery}`;
    replaceEditorText(editor, enriched);
  }

  await new Promise((r) => setTimeout(r, 80));
  fireBypassSend(editor);
  requestAnimationFrame(() => removeInjectionOverlay(overlay));
  if (contextText) scrubContextFromLastUserMessage();
}

// ─── Main Loop ────────────────────────────────────────────────────────────

function mainLoop() {
  const editor = findEditor();
  if (!editor) return;

  // Only show chip and autocomplete in search mode
  if (xmemMode === "search") {
    ensureChip(editor);
    positionChip(editor);
  } else {
    hideChip();
  }

  hookSendButtons();
  hookEnterKey(editor);
  if (idePanelOpen) applyIdePanelTheme();

  if (editor.dataset.xmemBound) return;
  editor.dataset.xmemBound = "1";

  const onInput = () => {
    dismissGhost();
    checkSlashCommand(editor);
    if (xmemMode !== "search") return;
    if (!chrome?.storage?.sync) return;
    chrome.storage.sync.get(["xmem_enabled", "xmem_live_suggest"], (data) => {
      if (data.xmem_enabled === false || data.xmem_live_suggest === false)
        return;
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

  editor.addEventListener("input", onInput);
  editor.addEventListener("keyup", onInput);

  editor.addEventListener("focus", () => {
    if (xmemMode === "search") {
      showChip();
      positionChip(editor);
    }
  });

  editor.addEventListener(
    "keydown",
    (e: Event) => {
      const ke = e as KeyboardEvent;
      if (handleSlashKeydown(ke, editor)) return;

      // IDE/Search: intercept Enter to inject context before send
      if (
        ke.key === "Enter" &&
        !ke.shiftKey &&
        (xmemMode === "ide" || xmemMode === "search")
      ) {
        if (bypassContextInjection) {
          bypassContextInjection = false;
          return;
        }
        ke.preventDefault();
        ke.stopImmediatePropagation();
        injectContextAndSend(editor);
        return;
      }

      if (ke.key === "Tab" && ghostAnswer) {
        ke.preventDefault();
        ke.stopPropagation();
        acceptGhost();
      } else if (ke.key === "Escape" && ghostAnswer) {
        ke.preventDefault();
        ke.stopPropagation();
        dismissGhost();
      }
    },
    true,
  );

  editor.addEventListener("blur", () => dismissGhost());
  editor.addEventListener("scroll", () => {
    if (!ghostAnswer) return;
    const pos = getCaretXY(editor);
    if (!pos || !ghostEl) {
      dismissGhost();
      return;
    }
    const edRect = editor.getBoundingClientRect();
    if (pos.y < edRect.top || pos.y > edRect.bottom) {
      dismissGhost();
      return;
    }
    ghostEl.style.left = `${pos.x}px`;
    ghostEl.style.top = `${pos.y}px`;
  });
}

// Dismiss ghost when cursor moves away from end
document.addEventListener("selectionchange", () => {
  if (!ghostAnswer) return;
  const ed = findEditor();
  if (!ed || !isCursorAtEnd(ed)) dismissGhost();
});

let observerActive = false;

function startObserver() {
  if (observerActive) return;
  observerActive = true;
  new MutationObserver(mainLoop).observe(document.body, {
    childList: true,
    subtree: true,
  });
  setupHighlightToRemember();
  mainLoop();
}

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === "M") {
    e.preventDefault();
    toggleSidebar();
  }
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "xmem_toggle_sidebar") toggleSidebar();
  return undefined;
});

// ─── Slash Command Detector ──────────────────────────────────────────────

interface SlashOption {
  command: string;
  mode: XMemMode;
  label: string;
  desc: string;
  color: string;
  icon: string;
}

const SLASH_OPTIONS: SlashOption[] = [
  {
    command: "Xingest",
    mode: "ingest",
    label: "Ingest",
    desc: "Save conversations to memory",
    color: "#a1a1aa",
    icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  },
  {
    command: "Xsearch",
    mode: "search",
    label: "Search",
    desc: "Auto-inject memory context on send",
    color: "#a1a1aa",
    icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  },
  {
    command: "Xide",
    mode: "ide",
    label: "IDE",
    desc: "Auto-inject code context on send",
    color: "#a1a1aa",
    icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  },
  {
    command: "Xrepo",
    mode: "repo",
    label: "Repo Tree",
    desc: "Browse & query codebase structure",
    color: "#a1a1aa",
    icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  },
];

function getSlashPrefix(editor: HTMLElement): string {
  const text = readEditorText(editor);
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("X")) return "";
  const spaceIdx = trimmed.indexOf(" ");
  return spaceIdx === -1 ? trimmed : trimmed.substring(0, spaceIdx);
}

function checkSlashCommand(editor: HTMLElement) {
  const prefix = getSlashPrefix(editor);
  if (!prefix) {
    dismissSlashDropdown();
    return;
  }

  const filtered = SLASH_OPTIONS.filter((o) => o.command.startsWith(prefix));

  if (filtered.length === 0) {
    dismissSlashDropdown();
    return;
  }

  const caret = getCaretXY(editor);
  if (!caret) return;

  showSlashDropdown(filtered, caret, editor, prefix);
}

function wireEffortToggle(dropdownEl: HTMLElement, options: SlashOption[], caret: CaretXY, editor: HTMLElement, currentPrefix: string) {
  dropdownEl.querySelectorAll<HTMLElement>(".xmem-switch-btn").forEach((btn) => {
    btn.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const level = btn.dataset.effort as EffortLevel;
      if (level && (level === "low" || level === "high")) {
        xmemEffortLevel = level;
        if (chrome?.storage?.sync) {
          chrome.storage.sync.set({ xmem_effort_level: level });
        }
        showSlashDropdown(options, caret, editor, currentPrefix);
      }
    });
  });
}

function showSlashDropdown(
  options: SlashOption[],
  caret: CaretXY,
  editor: HTMLElement,
  currentPrefix: string,
) {
  if (!slashDropdownEl) {
    slashDropdownEl = document.createElement("div");
    slashDropdownEl.id = "xmem-slash-dropdown";
    document.body.appendChild(slashDropdownEl);
  }
  slashDropdownEl.classList.toggle(
    "xmem-slash-light",
    !isDarkBackground(document.body),
  );

  slashSelectedIdx = Math.min(slashSelectedIdx, options.length - 1);

  slashDropdownEl.innerHTML = options
    .map(
      (opt, i) => {
        const isIngest = opt.mode === "ingest";
        const isHigh = isIngest && xmemEffortLevel === "high";
        
        const descText = isHigh ? "Higher cost, Better memories" : opt.desc;
        const descClass = isHigh ? "xmem-slash-desc xmem-effort-high-warn" : "xmem-slash-desc";

        let html = `
    <div class="xmem-slash-option ${i === slashSelectedIdx ? "xmem-slash-selected" : ""}" data-mode="${opt.mode}">
      <div class="xmem-slash-left">
        <div class="xmem-slash-icon">${opt.icon}</div>
        <div class="xmem-slash-text">
          <span class="xmem-slash-cmd">${opt.command}</span>
          <span class="${descClass}">${descText}</span>
        </div>
      </div>`;

        if (isIngest) {
          html += `
      <div class="xmem-slash-right">
        <button class="xmem-switch-btn ${isHigh ? "xmem-switch-on" : ""}" data-effort="${isHigh ? "low" : "high"}" title="Deep Extraction Effort">
          <div class="xmem-switch-knob"></div>
        </button>
      </div>`;
        }

        html += `</div>`;
        return html;
      },
    )
    .join("");

  slashDropdownEl.style.position = "fixed";
  slashDropdownEl.style.left = `${Math.max(8, caret.x - 8)}px`;
  slashDropdownEl.style.zIndex = "2147483647";
  // Show off-screen first to measure height, then position properly
  slashDropdownEl.style.top = "-9999px";
  slashDropdownEl.style.display = "block";

  const dropH = slashDropdownEl.offsetHeight || options.length * 52;
  const spaceBelow = window.innerHeight - (caret.y + caret.h);
  const spaceAbove = caret.y;

  if (spaceBelow >= dropH + 8 || spaceAbove < dropH + 8) {
    // Enough space below, OR not enough space above either — show below
    slashDropdownEl.style.top = `${caret.y + caret.h + 4}px`;
  } else {
    // Not enough space below — flip above the caret
    slashDropdownEl.style.top = `${caret.y - dropH - 4}px`;
  }

  slashDropdownEl
    .querySelectorAll<HTMLElement>(".xmem-slash-option")
    .forEach((el) => {
      el.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const mode = el.dataset.mode as XMemMode;
        if (mode) activateSlashMode(mode, editor, currentPrefix);
      });
    });

  wireEffortToggle(slashDropdownEl, options, caret, editor, currentPrefix);
}

function dismissSlashDropdown() {
  if (slashDropdownEl) slashDropdownEl.style.display = "none";
  slashSelectedIdx = 0;
}

function handleSlashKeydown(e: KeyboardEvent, editor: HTMLElement): boolean {
  if (!slashDropdownEl || slashDropdownEl.style.display === "none")
    return false;

  const prefix = getSlashPrefix(editor);
  const options = SLASH_OPTIONS.filter((o) => o.command.startsWith(prefix));
  if (options.length === 0) return false;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    e.stopPropagation();
    slashSelectedIdx = (slashSelectedIdx + 1) % options.length;
    showSlashDropdown(options, getCaretXY(editor)!, editor, prefix);
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    slashSelectedIdx = (slashSelectedIdx - 1 + options.length) % options.length;
    showSlashDropdown(options, getCaretXY(editor)!, editor, prefix);
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    e.stopPropagation();
    const selected = options[slashSelectedIdx];
    if (selected) activateSlashMode(selected.mode, editor, prefix);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    dismissSlashDropdown();
    return true;
  }
  return false;
}

function clearEditorText(editor: HTMLElement) {
  if (editor instanceof HTMLTextAreaElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (nativeSetter) nativeSetter.call(editor, "");
    else editor.value = "";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    editor.focus();
    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
  }
}

function activateSlashMode(
  mode: XMemMode,
  editor: HTMLElement,
  prefix: string,
) {
  dismissSlashDropdown();
  clearEditorText(editor);

  const prevMode = xmemMode;
  xmemMode = mode;

  if (chrome?.storage?.sync) {
    chrome.storage.sync.set({ xmem_mode: xmemMode });
  }

  // Cleanup ghost/chip/sidecar for non-search modes
  if (mode !== "search") {
    dismissGhost();
    hideChip();
    if (activeSidecar) {
      activeSidecar.remove();
      activeSidecar = null;
    }
  }

  // Close ide panel if leaving repo mode
  if (prevMode === "repo") closeIdePanel();

  if (mode === "search") {
    ensureChip(editor);
    positionChip(editor);
    showChip();
    closeIdePanel();
  } else if (mode === "repo") {
    // Repo tree: open the left panel for browsing/query
    closeIdePanel();
    openIdePanel();
  } else if (mode === "ide") {
    // IDE: context injection mode — panel stays closed, we intercept send
    closeIdePanel();
    if (chrome?.storage?.sync) {
      chrome.storage.sync.get(["xmem_ide_org_id", "xmem_ide_repo"], (data) => {
        ideOrgId = data.xmem_ide_org_id || "";
        ideRepo = data.xmem_ide_repo || "";
        if (!ideOrgId || !ideRepo) {
          showToast("Tip: use /repo to set up your codebase first", true);
        }
      });
    }
  } else if (mode === "ingest") {
    closeIdePanel();
  }

  const labels: Record<XMemMode, string> = {
    ingest: "Ingest \u2014 saving memories",
    search: "Search \u2014 auto-injects memory context",
    ide: "IDE \u2014 auto-injects code context on send",
    repo: "Repo Tree \u2014 browse & query codebase",
  };
  showToast(`Mode: ${labels[mode]}`);
}

// ─── IDE Panel ────────────────────────────────────────────────────────────

function applyIdePanelTheme() {
  if (!idePanelEl) return;
  const isLight = !isDarkBackground(document.body);
  idePanelEl.classList.toggle("xmem-ide-light", isLight);
}

function openIdePanel() {
  if (idePanelEl && document.body.contains(idePanelEl)) {
    idePanelEl.style.display = "flex";
    applyIdePanelTheme();
    idePanelOpen = true;
    return;
  }

  idePanelEl = document.createElement("div");
  idePanelEl.id = "xmem-ide-panel";

  if (chrome?.storage?.sync) {
    chrome.storage.sync.get(["xmem_ide_org_id", "xmem_ide_repo"], (data) => {
      ideOrgId = data.xmem_ide_org_id || "";
      ideRepo = data.xmem_ide_repo || "";
      renderIdePanel();
    });
  } else {
    renderIdePanel();
  }

  document.body.appendChild(idePanelEl);
  applyIdePanelTheme();
  idePanelOpen = true;
}

function closeIdePanel() {
  if (idePanelEl) {
    idePanelEl.style.display = "none";
  }
  idePanelOpen = false;
}

function renderIdePanel() {
  if (!idePanelEl) return;

  const isConfigured = ideOrgId && ideRepo;

  idePanelEl.innerHTML = `
    <div class="xmem-ide-header">
      <div class="xmem-ide-logo">
        <div class="xmem-ide-logo-icon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#71717a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
          </svg>
        </div>
        <span>xmem</span>
      </div>
      <button class="xmem-ide-close-btn" title="Close">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <div class="xmem-ide-config">
      <div class="xmem-ide-field">
        <label>Organization</label>
        <input type="text" id="xmem-ide-org" placeholder="zinnia" value="${escapeHtml(ideOrgId)}" />
      </div>
      <div class="xmem-ide-field">
        <label>Repository</label>
        <input type="text" id="xmem-ide-repo" placeholder="payment-service" value="${escapeHtml(ideRepo)}" />
      </div>
      <button class="xmem-ide-load-btn" id="xmem-ide-load">
        ${isConfigured ? "Reload" : "Load"}
      </button>
    </div>

    <div class="xmem-ide-tree-container" id="xmem-ide-tree">
      ${isConfigured && ideTreeData ? renderTreeHTML(ideTreeData) : '<div class="xmem-ide-empty">Configure organization and repository to begin.</div>'}
    </div>

    <div class="xmem-ide-query-section">
      <div class="xmem-ide-query-label">Search codebase</div>
      <div class="xmem-ide-query-bar">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input type="text" id="xmem-ide-query-input" placeholder="Ask about this codebase..." />
      </div>
      <div id="xmem-ide-query-result" class="xmem-ide-query-result"></div>
    </div>
  `;

  setupIdePanelEvents();
}

function setupIdePanelEvents() {
  if (!idePanelEl) return;

  idePanelEl
    .querySelector(".xmem-ide-close-btn")
    ?.addEventListener("click", () => {
      closeIdePanel();
      xmemMode = "search";
      if (chrome?.storage?.sync)
        chrome.storage.sync.set({ xmem_mode: "search" });
      showToast("Mode: Search");
      const editor = findEditor();
      if (editor) {
        ensureChip(editor);
        positionChip(editor);
        showChip();
      }
    });

  idePanelEl
    .querySelector("#xmem-ide-load")
    ?.addEventListener("click", async () => {
      const orgInput = idePanelEl!.querySelector(
        "#xmem-ide-org",
      ) as HTMLInputElement;
      const repoInput = idePanelEl!.querySelector(
        "#xmem-ide-repo",
      ) as HTMLInputElement;
      ideOrgId = orgInput.value.trim();
      ideRepo = repoInput.value.trim();

      if (!ideOrgId || !ideRepo) {
        showToast("Enter both Org ID and Repository", true);
        return;
      }

      if (chrome?.storage?.sync) {
        chrome.storage.sync.set({
          xmem_ide_org_id: ideOrgId,
          xmem_ide_repo: ideRepo,
        });
      }

      const treeContainer = idePanelEl!.querySelector(
        "#xmem-ide-tree",
      ) as HTMLElement;
      treeContainer.innerHTML = '<div class="xmem-loader"></div>';

      try {
        const result = await getDirectoryTree(ideOrgId, ideRepo);
        ideTreeData = result.tree;
        treeContainer.innerHTML = renderTreeHTML(ideTreeData);
        attachTreeToggleListeners(treeContainer);
      } catch (err) {
        treeContainer.innerHTML =
          '<div class="xmem-ide-empty">Failed to load directory tree</div>';
        console.error("XMem IDE tree error", err);
      }
    });

  const queryInput = idePanelEl.querySelector(
    "#xmem-ide-query-input",
  ) as HTMLInputElement;
  queryInput?.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const q = queryInput.value.trim();
    if (!q || !ideOrgId || !ideRepo) return;

    const resultDiv = idePanelEl!.querySelector(
      "#xmem-ide-query-result",
    ) as HTMLElement;
    resultDiv.innerHTML = '<div class="xmem-loader"></div>';

    let answerText = "";
    let sourcesHtml = "";
    let started = false;

    try {
      await streamCodeQuery(ideOrgId, ideRepo, q, (chunk) => {
        if (!started) {
          started = true;
          resultDiv.innerHTML = `
            <div class="xmem-answer">
              <div class="xmem-answer-text xmem-md-body"></div>
            </div>`;
        }

        if (chunk.type === "status") {
          const textDiv = resultDiv.querySelector(".xmem-answer-text");
          if (textDiv && !answerText) {
            textDiv.innerHTML = `<em>${escapeHtml(chunk.content)}</em>`;
          }
        } else if (chunk.type === "chunk") {
          answerText += chunk.text;
          const textDiv = resultDiv.querySelector(".xmem-answer-text");
          if (textDiv) {
            textDiv.innerHTML = renderMarkdown(answerText);
          }
        } else if (chunk.type === "sources") {
          if (chunk.sources && chunk.sources.length > 0) {
            sourcesHtml = `<div class="xmem-answer-sources"><span class="xmem-answer-sources-label">${chunk.sources.length} source${chunk.sources.length > 1 ? "s" : ""}</span></div>`;
          }
        } else if (chunk.type === "done") {
          if (sourcesHtml) {
            const answerDiv = resultDiv.querySelector(".xmem-answer");
            if (answerDiv)
              answerDiv.insertAdjacentHTML("beforeend", sourcesHtml);
          }
        }
      });
    } catch {
      resultDiv.innerHTML =
        '<div class="xmem-error">Failed to query codebase.</div>';
    }
  });

  idePanelEl.addEventListener("click", (e) => e.stopPropagation());

  const treeContainer = idePanelEl.querySelector(
    "#xmem-ide-tree",
  ) as HTMLElement;
  if (treeContainer && ideTreeData) attachTreeToggleListeners(treeContainer);
}

function renderTreeHTML(node: DirectoryNode, depth = 0): string {
  if (node.type === "file") {
    const ext = node.name.split(".").pop() || "";
    const iconClass = getFileIconClass(ext);
    return `<div class="xmem-tree-file" style="padding-left: ${12 + depth * 16}px" data-path="${escapeHtml(node.path)}">
      <span class="xmem-tree-icon ${iconClass}"></span>
      <span class="xmem-tree-name">${escapeHtml(node.name)}</span>
    </div>`;
  }

  const children = (node.children || [])
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((c) => renderTreeHTML(c, depth + 1))
    .join("");

  if (depth === 0) {
    return `<div class="xmem-tree-dir xmem-tree-open" data-path="${escapeHtml(node.path)}">
      <div class="xmem-tree-dir-header" style="padding-left: ${12 + depth * 16}px">
        <span class="xmem-tree-arrow"></span>
        <span class="xmem-tree-folder-icon"></span>
        <span class="xmem-tree-name">${escapeHtml(node.name)}</span>
      </div>
      <div class="xmem-tree-children">${children}</div>
    </div>`;
  }

  return `<div class="xmem-tree-dir" data-path="${escapeHtml(node.path)}">
    <div class="xmem-tree-dir-header" style="padding-left: ${12 + depth * 16}px">
      <span class="xmem-tree-arrow"></span>
      <span class="xmem-tree-folder-icon"></span>
      <span class="xmem-tree-name">${escapeHtml(node.name)}</span>
    </div>
    <div class="xmem-tree-children">${children}</div>
  </div>`;
}

function getFileIconClass(ext: string): string {
  const map: Record<string, string> = {
    py: "xmem-icon-py",
    ts: "xmem-icon-ts",
    tsx: "xmem-icon-ts",
    js: "xmem-icon-js",
    jsx: "xmem-icon-js",
    json: "xmem-icon-json",
    md: "xmem-icon-md",
    css: "xmem-icon-css",
    html: "xmem-icon-html",
    yaml: "xmem-icon-yaml",
    yml: "xmem-icon-yaml",
    java: "xmem-icon-java",
    go: "xmem-icon-go",
    rs: "xmem-icon-rs",
  };
  return map[ext.toLowerCase()] || "xmem-icon-file";
}

function attachTreeToggleListeners(container: HTMLElement) {
  container
    .querySelectorAll<HTMLElement>(".xmem-tree-dir-header")
    .forEach((header) => {
      header.addEventListener("click", () => {
        const dir = header.parentElement;
        if (dir) dir.classList.toggle("xmem-tree-open");
      });
    });
}

// ─── Load Saved Mode ──────────────────────────────────────────────────────

function loadSavedMode() {
  if (chrome?.storage?.sync) {
    chrome.storage.sync.get(
      ["xmem_mode", "xmem_ide_org_id", "xmem_ide_repo", "xmem_effort_level"],
      (data) => {
        if (
          data.xmem_mode === "ingest" ||
          data.xmem_mode === "search" ||
          data.xmem_mode === "ide" ||
          data.xmem_mode === "repo"
        ) {
          xmemMode = data.xmem_mode;
        }
        if (data.xmem_effort_level === "low" || data.xmem_effort_level === "high") {
          xmemEffortLevel = data.xmem_effort_level;
        }
        ideOrgId = data.xmem_ide_org_id || "";
        ideRepo = data.xmem_ide_repo || "";
        if (xmemMode === "repo") openIdePanel();
      },
    );
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────

injectStyles();
startObserver();
loadSavedMode();

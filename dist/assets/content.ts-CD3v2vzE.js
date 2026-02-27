import{i as z,r as j,s as T}from"./api-CPTTBvTz.js";let m=!1,a=null,s=null,b=[],h=null,p=null,w="",v="";const q=400,H=8,I=["#prompt-textarea",'div.ProseMirror[contenteditable="true"]','div[contenteditable="true"]',"textarea[placeholder]","rich-textarea textarea","textarea"];function f(){for(const e of I){const t=document.querySelector(e);if(t&&t.offsetParent!==null)return t}return null}function g(e){return e instanceof HTMLTextAreaElement?e.value:e.textContent||""}function A(e){return s&&document.body.contains(s)||(s=document.createElement("div"),s.id="xmem-chip",s.innerHTML=`
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
  `,document.body.appendChild(s),y(e),s.addEventListener("click",t=>{t.stopPropagation(),d()})),s}function y(e){if(!s)return;const t=e.getBoundingClientRect();s.style.position="fixed",s.style.top=`${t.top-36}px`,s.style.left=`${t.right-160}px`,s.style.zIndex="2147483646"}function l(e,t=!1){if(!s)return;const n=s.querySelector(".xmem-chip-count"),o=s.querySelector(".xmem-chip-label"),r=s.querySelector(".xmem-chip-inner");n&&(n.textContent=t?"...":String(e)),o&&(o.textContent=t?"searching":e===1?"memory":"memories"),r&&(r.classList.toggle("xmem-chip-active",e>0||t),r.classList.toggle("xmem-chip-loading",t))}function E(){s&&(s.style.display="block")}function B(){return a&&document.body.contains(a)||(a=document.createElement("div"),a.id="xmem-sidebar",a.innerHTML=`
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
  `,document.body.appendChild(a),_(a)),a}function _(e){e.querySelector("#xmem-sb-close")?.addEventListener("click",()=>d()),e.querySelectorAll(".xmem-sb-tab").forEach(n=>{n.addEventListener("click",()=>{e.querySelectorAll(".xmem-sb-tab").forEach(r=>r.classList.remove("active")),e.querySelectorAll(".xmem-sb-panel").forEach(r=>r.classList.remove("active")),n.classList.add("active");const o=`xmem-panel-${n.dataset.tab}`;e.querySelector(`#${o}`)?.classList.add("active")})});const t=e.querySelector("#xmem-sb-search");t?.addEventListener("input",()=>{const n=t.value.trim();n.length>=3?R(n):n.length===0&&x(b)}),e.querySelector("#xmem-sb-save")?.addEventListener("click",async()=>{const n=f();if(!n)return;const o=g(n).trim();if(o)try{await z(o),k("Memory saved!")}catch{k("Failed to save memory",!0)}}),e.querySelector("#xmem-ask-btn")?.addEventListener("click",async()=>{const n=e.querySelector("#xmem-ask-input"),o=e.querySelector("#xmem-ask-result"),r=n?.value.trim();if(r){o.innerHTML='<div class="xmem-loader"></div>';try{const i=await j(r);o.innerHTML=`
        <div class="xmem-answer">
          <div class="xmem-answer-text">${u(i.answer)}</div>
          ${i.sources.length>0?`
            <div class="xmem-answer-sources">
              <span class="xmem-answer-sources-label">${i.sources.length} source${i.sources.length>1?"s":""}</span>
              ${i.sources.map(c=>`
                <div class="xmem-source-item">
                  <span class="xmem-domain-tag xmem-domain-${c.domain}">${c.domain}</span>
                  <span>${u(c.content.substring(0,100))}</span>
                </div>
              `).join("")}
            </div>
          `:""}
        </div>
      `}catch{o.innerHTML='<div class="xmem-error">Failed to retrieve answer. Check connection.</div>'}}}),e.addEventListener("click",n=>n.stopPropagation())}function d(){const e=B();m=!m,e.classList.toggle("xmem-sb-open",m),m?(x(b),document.addEventListener("click",L),document.addEventListener("keydown",M)):(document.removeEventListener("click",L),document.removeEventListener("keydown",M))}function L(e){a&&!a.contains(e.target)&&s&&!s.contains(e.target)&&m&&d()}function M(e){e.key==="Escape"&&m&&d()}function x(e){const t=document.getElementById("xmem-panel-memories");if(!t)return;const n=document.getElementById("xmem-stat-results");if(n&&(n.textContent=String(e.length)),e.length===0){t.innerHTML=`
      <div class="xmem-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#52525b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a7 7 0 0 1 7 7c0 3-2 5.5-4 7l-3 3.5L9 16c-2-1.5-4-4-4-7a7 7 0 0 1 7-7z"/>
          <circle cx="12" cy="9" r="2.5"/>
        </svg>
        <p>No memories found</p>
        <span>Start typing in a chat to see relevant memories</span>
      </div>
    `;return}t.innerHTML=e.map((o,r)=>`
    <div class="xmem-memory-card" data-idx="${r}">
      <div class="xmem-memory-header">
        <span class="xmem-domain-tag xmem-domain-${o.domain}">${o.domain}</span>
        <span class="xmem-score">${(o.score*100).toFixed(0)}%</span>
      </div>
      <div class="xmem-memory-text">${u(o.content)}</div>
      <div class="xmem-memory-actions">
        <button class="xmem-copy-btn" data-idx="${r}" title="Copy to clipboard">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
          </svg>
        </button>
        <button class="xmem-inject-btn" data-idx="${r}" title="Add to prompt">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add
        </button>
      </div>
    </div>
  `).join(""),t.querySelectorAll(".xmem-copy-btn").forEach(o=>{o.addEventListener("click",r=>{r.stopPropagation();const i=parseInt(o.dataset.idx||"0",10),c=e[i];c&&navigator.clipboard.writeText(c.content).then(()=>{o.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',setTimeout(()=>{o.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'},1500)})})}),t.querySelectorAll(".xmem-inject-btn").forEach(o=>{o.addEventListener("click",r=>{r.stopPropagation();const i=parseInt(o.dataset.idx||"0",10),c=e[i];c&&X(c)})})}function X(e){const t=f();if(!t)return;const n=`

[XMem ${e.domain}] ${e.content}
`;if(t instanceof HTMLTextAreaElement)t.value+=n,t.dispatchEvent(new Event("input",{bubbles:!0}));else{const o=document.createElement("div");o.innerHTML=`<br><span style="background:#dbeafe;padding:2px 6px;border-radius:4px;font-size:13px;color:#1e40af;" contenteditable="false">[XMem/${e.domain}] ${u(e.content)}</span>`,t.appendChild(o),t.dispatchEvent(new Event("input",{bubbles:!0}))}k("Memory added to prompt")}async function P(e){if(e.length<H){l(0);return}if(e===w)return;w=e,p&&(p.cancelled=!0),p={cancelled:!1};const t=p;l(0,!0);try{const n=await T(e,{topK:10});if(t.cancelled)return;b=n,l(n.length),m&&x(n)}catch{if(t.cancelled)return;l(0)}}async function R(e){try{const t=await T(e,{topK:15});b=t,x(t)}catch{x([])}}function D(){const e=['button[data-testid="send-button"]',"#composer-submit-button",'button[aria-label="Send Message"]','button[aria-label="Send message"]','button[type="submit"]'];for(const t of e){const n=document.querySelector(t);n&&!n.dataset.xmemHooked&&(n.dataset.xmemHooked="true",n.addEventListener("click",$,!0))}}function F(e){e.dataset.xmemEnterHooked||(e.dataset.xmemEnterHooked="true",e.addEventListener("keydown",t=>{const n=t;n.key==="Enter"&&!n.shiftKey&&(v=g(e),setTimeout($,50))}))}async function $(){if(!await new Promise(r=>{chrome.storage.sync.get(["xmem_enabled"],i=>r(i.xmem_enabled!==!1))}))return;const t=f(),n=v||(t?g(t):"");if(!n||n.trim().length<5)return;const o=n.replace(/<[^>]+>/g,"").replace(/\[XMem[^\]]*\][^\n]*/g,"").trim();if(o){try{await z(o)}catch(r){console.error("XMem: auto-save failed",r)}v=""}}function k(e,t=!1){const n=document.getElementById("xmem-toast");n&&n.remove();const o=document.createElement("div");o.id="xmem-toast",o.className=t?"xmem-toast-error":"xmem-toast-success",o.textContent=e,document.body.appendChild(o),requestAnimationFrame(()=>o.classList.add("xmem-toast-visible")),setTimeout(()=>{o.classList.remove("xmem-toast-visible"),setTimeout(()=>o.remove(),300)},2500)}function u(e){const t=document.createElement("div");return t.textContent=e,t.innerHTML}function K(){if(document.getElementById("xmem-styles"))return;const e=document.createElement("style");e.id="xmem-styles",e.textContent=`
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
  `,document.head.appendChild(e)}let S=!1;function C(){const e=f();if(e&&(A(e),y(e),D(),F(e),!e.dataset.xmemInputHooked)){e.dataset.xmemInputHooked="true";const t=()=>{chrome.storage.sync.get(["xmem_enabled","xmem_live_suggest"],n=>{if(n.xmem_enabled===!1||n.xmem_live_suggest===!1)return;const o=g(e).trim();h&&clearTimeout(h),o.length>=H?(E(),h=setTimeout(()=>P(o),q)):l(0)})};e.addEventListener("input",t),e.addEventListener("keyup",t),e.addEventListener("focus",()=>{E(),y(e)})}}function O(){if(S)return;S=!0,new MutationObserver(()=>{C()}).observe(document.body,{childList:!0,subtree:!0}),C()}document.addEventListener("keydown",e=>{e.ctrlKey&&e.shiftKey&&e.key==="M"&&(e.preventDefault(),d())});chrome.runtime.onMessage.addListener(e=>{e.action==="xmem_toggle_sidebar"&&d()});K();O();

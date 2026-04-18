<div align="center">

# XMem

**Real-time memory recall for AI conversations.**

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](chrome://extensions/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5.4-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev/)

XMem watches what you type in ChatGPT, Claude, Gemini, Perplexity, and DeepSeek — then surfaces relevant memories from your personal memory store before you hit send.

---

</div>

## See it in action

### Demo

https://github.com/user-attachments/assets/8e3349ab-63c9-4046-821d-ca8097948440

### Setup

https://github.com/user-attachments/assets/72bf4e7d-2308-43ec-8da8-343f3293ac3a

---

## How it works

```
You type in an AI chat
        |
        v
XMem debounces your input (600ms)
        |
        v
Semantic search hits your XMem server
        |
        v
Relevant memories appear as ghost text + floating chip
        |
        v
Tab to accept  ·  Click chip to browse  ·  Memories inject into your prompt
```

---

## Features

### Live suggestions

As you type in any supported AI chat, XMem performs semantic search against your memory store and renders **ghost text** inline — press **Tab** to accept, **Escape** to dismiss. A floating chip displays the count of matching memories. Searches fire only after 8+ characters and only when the cursor is at the end of input.

### Sidebar panel &ensp; `Ctrl+Shift+M`

| Tab | What it does |
|-----|-------------|
| **Memories** | Browse results with domain tags (`profile`, `temporal`, `summary`) and relevance scores |
| **Ask Memory** | Ask natural-language questions — get LLM-generated answers backed by your stored memories |
| **Settings** | Connection status, configured domains, version info |

### Auto-save

Your outgoing messages are captured and ingested automatically after the AI finishes responding. You can also right-click any selected text on any page and choose **"Save to XMem Memory"**.

### Slash commands

| Command | Mode |
|---------|------|
| `/Xingest` | Queue-based ingestion — saves conversations to memory without blocking the UI |
| `/Xsearch` | Auto-inject synthesized memory context when you send a message |
| `/Xide` | Auto-inject codebase context on send (IDE mode) |
| `/Xrepo` | Browse and query your codebase structure via a file tree panel |

### IDE / Code mode

Browse a codebase directory tree from the left panel. Query it semantically ("What does the payment service do?") and get streaming responses with file and symbol references extracted automatically.

---

## Supported sites

| Platform | Domain |
|----------|--------|
| ChatGPT | `chatgpt.com` `chat.openai.com` |
| Claude | `claude.ai` |
| Gemini | `gemini.google.com` |
| Perplexity | `perplexity.ai` |
| DeepSeek | `chat.deepseek.com` |
| Other | Any page with standard `<textarea>` or `contenteditable` fields |

---

## Getting started

### Prerequisites

- Chrome browser
- A running [XMem server](https://github.com/xortex-ai/xmem) (default: `http://localhost:8000`)
- Node.js 20+

### Build

```bash
npm install
npm run build
```

For development with hot reload:

```bash
npm run dev
```

### Install in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder

### Configure

1. Click the XMem icon in the Chrome toolbar
2. Enter your **API URL** (e.g. `http://localhost:8000`)
3. Enter your **API Key** (if required)
4. Set your **User ID**
5. Click **Save Settings**
6. Click **Test** to verify the connection — a green dot confirms you're live

---

## Configuration reference

| Setting | Storage key | Default | Description |
|---------|------------|---------|-------------|
| API URL | `xmem_api_url` | `http://localhost:8000` | XMem backend endpoint |
| API Key | `xmem_api_key` | — | Authentication token |
| User ID | `xmem_user_id` | `chrome-extension-user` | Your user identifier |
| Memory Active | `xmem_enabled` | `true` | Master on/off switch |
| Live Suggestions | `xmem_live_suggest` | `true` | Ghost text inline suggestions |
| IDE Org ID | `xmem_ide_org_id` | — | Organization for code context |
| IDE Repo | `xmem_ide_repo` | — | Repository for code context |
| Effort Level | `xmem_effort_level` | `low` | Ingestion detail level (`low` / `high`) |

---

## Architecture

```
xmem-extension/
  src/
    api.ts            API client + request queue (wraps xmem-ai SDK)
    background.ts     Service worker — context menus, message routing
    content.ts        Core logic — editor detection, live search, sidebar, auto-save
    popup.html        Settings UI (dark mode, 360px popup)
    popup.ts          Settings persistence via chrome.storage.sync
  icons/              Extension icons (16, 48, 128 px)
  manifest.json       Chrome Manifest V3
  vite.config.ts      Build config (@crxjs/vite-plugin)
```

### API endpoints used

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/v1/memory/ingest` | Save messages and responses |
| `POST` | `/v1/memory/search` | Semantic search across memory domains |
| `POST` | `/v1/memory/retrieve` | LLM-synthesized answers from memory |
| `GET` | `/health` | Server connectivity check |
| `GET` | `/ping` | Health status with version |
| `POST` | `/v1/code/query_stream` | Stream code query results |
| `GET` | `/v1/code/directory_tree` | Codebase directory structure |
| `GET` | `/v1/code/list_repos` | Available repositories |

### Key internals

- **Request queue** — All API calls are serialized to prevent `INVALID_CONCURRENT_GRAPH_UPDATE` errors from the LangGraph backend
- **Editor detection** — A `MutationObserver` watches the DOM for editable fields using per-site CSS selectors
- **React compatibility** — Uses native property setters to update React-controlled textareas (ChatGPT)
- **Theme-aware** — Detects light/dark backgrounds to style ghost text appropriately
- **Ingestion queue** — Separate queue for batch saves so the UI never blocks

---

<div align="center">

Built by [Xortex](https://github.com/xortex-ai)

</div>

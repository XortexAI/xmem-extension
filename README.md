# XMem Chrome Extension

A powerful Chrome extension that provides **real-time memory recall** for AI conversations. Unlike simple sidebar-only extensions, XMem works **dynamically** while you're typing and chatting — surfacing relevant memories from your XMem server as you compose messages.

## Features

### Dynamic Memory Recall
- **Real-time as you type**: As you write in ChatGPT, Claude, Gemini, Perplexity, or any AI chat, XMem searches your memory store and shows a floating chip with the number of relevant memories
- **Debounced search**: Searches are automatically debounced (400ms) to avoid hammering the API
- **Inline injection**: Click "Add" on any memory to inject it directly into your chat prompt

### Sidebar Panel (Ctrl+Shift+M)
- **Memories tab**: Browse all relevant memories with domain tags (profile, temporal, summary) and relevance scores
- **Ask Memory tab**: Ask questions directly to XMem and get LLM-generated answers backed by your stored memories
- **Settings tab**: View connection stats and domains

### Auto-Save
- Automatically captures and saves your messages to XMem when you send them
- Right-click any text on any page → "Save to XMem Memory"

### Multi-Site Support
Works on:
- ChatGPT (chatgpt.com)
- Claude (claude.ai)
- Gemini (gemini.google.com)
- Perplexity (perplexity.ai)
- DeepSeek (chat.deepseek.com)
- Any site with standard text editors

## Setup

### Prerequisites
- A running XMem server (default: `http://localhost:8000`)
- Node.js 20+ for building

### Build
```bash
npm install
npm run build
```

### Install in Chrome
1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist/` folder

### Configure
1. Click the XMem extension icon in Chrome toolbar
2. Enter your XMem API URL (e.g., `http://localhost:8000`)
3. Enter your API key (if required)
4. Set your User ID
5. Click "Save Settings"
6. Click "Test" to verify connection

## Architecture

```
src/
  api.ts        — XMem REST API client (ingest, search, retrieve, health)
  background.ts — Service worker (context menus, message routing)
  popup.html/ts — Extension popup for settings and configuration
  content.ts    — Content script (editor detection, live search, sidebar, auto-save)
```

### How the Dynamic Features Work

1. **Editor Detection**: A MutationObserver watches the DOM for editable fields (textarea, contenteditable) using selectors specific to ChatGPT, Claude, Gemini, etc.

2. **Live Search**: Input events on detected editors are debounced and trigger semantic search calls to `/v1/memory/search` on your XMem server.

3. **Floating Chip**: A small pill-shaped indicator appears near the editor showing the count of relevant memories. Click it to open the sidebar.

4. **Auto-Save**: Send button clicks and Enter keypresses are intercepted to capture the message text, which is then posted to `/v1/memory/ingest`.

## XMem API Endpoints Used

| Endpoint | Purpose |
|---|---|
| `POST /v1/memory/ingest` | Save new memories |
| `POST /v1/memory/search` | Semantic search across memory domains |
| `POST /v1/memory/retrieve` | Get LLM-generated answers from memory |
| `GET /health` | Check server connectivity |

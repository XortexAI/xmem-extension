/**
 * XMem API layer for the Chrome extension.
 * Wraps the xmem-ai SDK client, pulling config from chrome.storage.
 *
 * API URL is hardcoded to https://api.xmem.in — not exposed to users.
 */

import { XMemClient } from 'xmem-ai';
import type {
  SourceRecord,
  IngestResult,
  RetrieveResult,
  HealthStatus,
  CodeQueryResult,
  DirectoryTreeResult,
  DirectoryNode,
  RepoListResult,
} from 'xmem-ai';

export type {
  SourceRecord, IngestResult, RetrieveResult, HealthStatus,
  CodeQueryResult, DirectoryTreeResult, DirectoryNode, RepoListResult,
};

/** Hardcoded API endpoint — never exposed to end users. */
const API_BASE_URL = 'https://api.xmem.in';

export interface XMemConfig {
  apiKey: string;
  userId: string;
}

let _cachedClient: XMemClient | null = null;
let _cachedConfigKey = '';

// Invalidate cached client when settings change
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') {
      if (changes.xmem_api_key || changes.xmem_user_id) {
        console.log('[XMem] Config changed, invalidating cached client');
        _cachedClient = null;
        _cachedConfigKey = '';
      }
    }
  });
}

// ─── Config (stored in chrome.storage) ────────────────────────────────────

export async function getConfig(): Promise<XMemConfig> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['xmem_api_key', 'xmem_user_id'], (data) => {
      resolve({
        apiKey: data.xmem_api_key || '',
        userId: data.xmem_user_id || '',
      });
    });
  });
}

export async function saveConfig(config: Partial<XMemConfig>): Promise<void> {
  return new Promise((resolve) => {
    const payload: Record<string, string> = {};
    if (config.apiKey !== undefined) payload.xmem_api_key = config.apiKey;
    if (config.userId !== undefined) payload.xmem_user_id = config.userId;
    chrome.storage.sync.set(payload, resolve);
  });
}

// ─── SDK Client ───────────────────────────────────────────────────────────

async function getClient(): Promise<{ client: XMemClient; userId: string }> {
  const config = await getConfig();
  const configKey = `${config.apiKey}|${config.userId}`;

  if (!_cachedClient || configKey !== _cachedConfigKey) {
    _cachedClient = new XMemClient(API_BASE_URL, config.apiKey, config.userId);
    _cachedConfigKey = configKey;
  }

  return { client: _cachedClient, userId: config.userId };
}

// ─── API Request Queue ──────────────────────────────────────────────────────

/**
 * The XMem backend (LangGraph) can throw INVALID_CONCURRENT_GRAPH_UPDATE if multiple 
 * requests modify the same user's thread graph state at exactly the same time.
 * We queue all requests to ensure they process sequentially.
 */
class RequestQueue {
  private queue: (() => Promise<void>)[] = [];
  private isProcessing = false;

  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const res = await task();
          resolve(res);
        } catch (err) {
          reject(err);
        }
      });
      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  }

  private async processQueue() {
    this.isProcessing = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        try {
          await task();
        } catch (e) {
          console.error("Queue task failed", e);
        }
      }
    }
    this.isProcessing = false;
  }
}

const apiQueue = new RequestQueue();

// ─── Public API Functions ─────────────────────────────────────────────────

export async function ingestMemory(
  text: string,
  agentResponse: string = '',
  effortLevel: 'low' | 'high' = 'low',
): Promise<IngestResult> {
  return apiQueue.enqueue(async () => {
    const { client, userId } = await getClient();
    console.log('[XMem] Ingesting memory for user:', userId, 'effort:', effortLevel);
    try {
      const result = await client.ingest({
        user_query: text,
        agent_response: agentResponse,
        user_id: userId,
        effort_level: effortLevel,
      });
      console.log('[XMem] Ingest result:', result);
      return result;
    } catch (err) {
      console.error('[XMem] Ingest error:', err);
      throw err;
    }
  });
}

export async function searchMemories(
  query: string,
  opts: { domains?: string[]; topK?: number } = {},
): Promise<SourceRecord[]> {
  return apiQueue.enqueue(async () => {
    const { client, userId } = await getClient();
    console.log('[XMem] Searching memories for user:', userId, 'query:', query.slice(0, 50));
    try {
      const result = await client.search({
        query,
        user_id: userId,
        domains: opts.domains || ['profile', 'temporal', 'summary'],
        top_k: opts.topK || 10,
      });
      console.log('[XMem] Search returned', result.results?.length || 0, 'results');
      return result.results;
    } catch (err) {
      console.error('[XMem] Search error:', err);
      throw err;
    }
  });
}

export async function retrieveAnswer(
  query: string,
  opts: { topK?: number } = {},
): Promise<RetrieveResult> {
  return apiQueue.enqueue(async () => {
    const { client, userId } = await getClient();
    console.log('[XMem] Retrieving answer for user:', userId, 'query:', query.slice(0, 50));
    try {
      const result = await client.retrieve({
        query,
        user_id: userId,
        top_k: opts.topK || 5,
      });
      console.log('[XMem] Retrieve result:', result.answer?.slice(0, 100));
      return result;
    } catch (err) {
      console.error('[XMem] Retrieve error:', err);
      throw err;
    }
  });
}

export async function checkHealth(): Promise<boolean> {
  try {
    const { client } = await getClient();
    const ready = await client.isReady();
    console.log('[XMem] Health check:', ready ? 'ready' : 'not ready');
    return ready;
  } catch (err) {
    console.error('[XMem] Health check error:', err);
    return false;
  }
}

export async function getHealthStatus(): Promise<HealthStatus> {
  const { client } = await getClient();
  console.log('[XMem] Getting health status from:', API_BASE_URL);
  try {
    const status = await client.ping();
    console.log('[XMem] Health status:', status);
    return status;
  } catch (err) {
    console.error('[XMem] Health status error:', err);
    throw err;
  }
}

export async function validateCredentials(apiKey: string, username: string): Promise<boolean> {
  const url = `${API_BASE_URL}/auth/verify-key`;
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      console.log('[XMem] Validation failed: HTTP', response.status);
      return false; // Key might be invalid
    }

    const data = await response.json();
    console.log('[XMem] Validated user data:', data);
    
    // Check if the username returned by the backend matches what the user entered
    if (data.username && data.username.toLowerCase() === username.toLowerCase()) {
      return true;
    }
    
    console.error('[XMem] Validation failed: Username mismatch.', {
      entered: username,
      actual: data.username
    });
    return false;
  } catch (err) {
    console.error('[XMem] Credential validation network error:', err);
    return false;
  }
}

// ─── Code Retrieval (IDE mode) ────────────────────────────────────────────

export async function queryCode(
  orgId: string,
  repo: string,
  query: string,
  opts: { topK?: number } = {},
): Promise<CodeQueryResult> {
  return apiQueue.enqueue(async () => {
    const { client, userId } = await getClient();
    console.log('[XMem] Code query:', query.slice(0, 50));
    try {
      const result = await client.codeQuery({
        org_id: orgId,
        repo,
        query,
        user_id: userId,
        top_k: opts.topK || 10,
      });
      console.log('[XMem] Code query result:', result.answer?.slice(0, 100));
      return result;
    } catch (err) {
      console.error('[XMem] Code query error:', err);
      throw err;
    }
  });
}

export async function streamCodeQuery(
  orgId: string,
  repo: string,
  query: string,
  onChunk: (chunk: any) => void,
  opts: { topK?: number } = {},
): Promise<void> {
  const config = await getConfig();
  const url = `${API_BASE_URL}/v1/code/query_stream`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      org_id: orgId,
      repo,
      query,
      user_id: config.userId,
      top_k: opts.topK || 10
    })
  });

  if (!response.ok || !response.body) {
    throw new Error(`Stream failed with status ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        onChunk(data);
      } catch (e) {
        console.error("Failed to parse stream line:", line);
      }
    }
  }
}

export async function getDirectoryTree(
  orgId: string,
  repo: string,
): Promise<DirectoryTreeResult> {
  const { client } = await getClient();
  console.log('[XMem] Fetching directory tree for', orgId, repo);
  try {
    const result = await client.getDirectoryTree(orgId, repo);
    console.log('[XMem] Directory tree loaded');
    return result;
  } catch (err) {
    console.error('[XMem] Directory tree error:', err);
    throw err;
  }
}

export async function listRepos(
  orgId: string,
): Promise<RepoListResult> {
  const { client } = await getClient();
  console.log('[XMem] Listing repos for org:', orgId);
  try {
    const result = await client.listRepos(orgId);
    console.log('[XMem] Repos:', result.repos);
    return result;
  } catch (err) {
    console.error('[XMem] List repos error:', err);
    throw err;
  }
}

// ─── Scanner Repos (fetch user's indexed repos from scanner) ──────────────

export interface ScannerRepo {
  org: string;
  repo: string;
  phase1_status: string;
  phase2_status: string;
}

export async function listScannerRepos(): Promise<ScannerRepo[]> {
  const config = await getConfig();
  if (!config.userId) return [];

  const url = `${API_BASE_URL}/v1/scanner/repos?username=${encodeURIComponent(config.userId)}`;
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
    });
    if (!response.ok) {
      console.error('[XMem] Scanner repos error:', response.status);
      return [];
    }
    const data = await response.json();
    return (data.repos || []) as ScannerRepo[];
  } catch (err) {
    console.error('[XMem] Scanner repos error:', err);
    return [];
  }
}

/**
 * XMem API layer for the Chrome extension.
 * Wraps the xmem-ai SDK client, pulling config from chrome.storage.
 */

import { XMemClient } from 'xmem-ai';
import type {
  SourceRecord,
  IngestResult,
  RetrieveResult,
  HealthStatus,
} from 'xmem-ai';

export type { SourceRecord, IngestResult, RetrieveResult, HealthStatus };

export interface XMemConfig {
  apiUrl: string;
  apiKey: string;
  userId: string;
}

let _cachedClient: XMemClient | null = null;
let _cachedConfigKey = '';

// Invalidate cached client when settings change
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') {
      if (changes.xmem_api_url || changes.xmem_api_key) {
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
    chrome.storage.sync.get(['xmem_api_url', 'xmem_api_key', 'xmem_user_id'], (data) => {
      resolve({
        apiUrl: data.xmem_api_url || 'http://localhost:8000',
        apiKey: data.xmem_api_key || '',
        userId: data.xmem_user_id || 'chrome-extension-user',
      });
    });
  });
}

export async function saveConfig(config: Partial<XMemConfig>): Promise<void> {
  return new Promise((resolve) => {
    const payload: Record<string, string> = {};
    if (config.apiUrl !== undefined) payload.xmem_api_url = config.apiUrl;
    if (config.apiKey !== undefined) payload.xmem_api_key = config.apiKey;
    if (config.userId !== undefined) payload.xmem_user_id = config.userId;
    chrome.storage.sync.set(payload, resolve);
  });
}

// ─── SDK Client ───────────────────────────────────────────────────────────

async function getClient(): Promise<{ client: XMemClient; userId: string }> {
  const config = await getConfig();
  const configKey = `${config.apiUrl}|${config.apiKey}`;

  if (!_cachedClient || configKey !== _cachedConfigKey) {
    _cachedClient = new XMemClient(config.apiUrl, config.apiKey);
    _cachedConfigKey = configKey;
  }

  return { client: _cachedClient, userId: config.userId };
}

// ─── Public API Functions ─────────────────────────────────────────────────

export async function ingestMemory(
  text: string,
  agentResponse: string = '',
): Promise<IngestResult> {
  const { client, userId } = await getClient();
  console.log('[XMem] Ingesting memory for user:', userId);
  try {
    const result = await client.ingest({
      user_query: text,
      agent_response: agentResponse,
      user_id: userId,
    });
    console.log('[XMem] Ingest result:', result);
    return result;
  } catch (err) {
    console.error('[XMem] Ingest error:', err);
    throw err;
  }
}

export async function searchMemories(
  query: string,
  opts: { domains?: string[]; topK?: number } = {},
): Promise<SourceRecord[]> {
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
}

export async function retrieveAnswer(
  query: string,
  opts: { topK?: number } = {},
): Promise<RetrieveResult> {
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
  const config = await getConfig();
  console.log('[XMem] Getting health status from:', config.apiUrl);
  try {
    const status = await client.ping();
    console.log('[XMem] Health status:', status);
    return status;
  } catch (err) {
    console.error('[XMem] Health status error:', err);
    throw err;
  }
}

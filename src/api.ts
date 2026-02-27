/**
 * XMem API layer for the Chrome extension.
 * Wraps the xmem-ai SDK client, reading config from chrome.storage.
 */

import { XMemClient } from 'xmem-ai';
import type {
  SourceRecord,
  IngestResult,
  RetrieveResult,
  SearchResult,
  HealthStatus,
} from 'xmem-ai';

export type { SourceRecord, IngestResult, RetrieveResult, SearchResult, HealthStatus };

export interface XMemConfig {
  apiUrl: string;
  apiKey: string;
  userId: string;
}

let _cachedClient: XMemClient | null = null;
let _cachedConfigKey = '';

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
    chrome.storage.sync.set(payload, () => {
      _cachedClient = null;
      resolve();
    });
  });
}

async function getClient(): Promise<{ client: XMemClient; userId: string }> {
  const config = await getConfig();
  const configKey = `${config.apiUrl}|${config.apiKey}`;
  if (!_cachedClient || configKey !== _cachedConfigKey) {
    _cachedClient = new XMemClient(config.apiUrl, config.apiKey);
    _cachedConfigKey = configKey;
  }
  return { client: _cachedClient, userId: config.userId };
}

export async function ingestMemory(
  text: string,
  agentResponse: string = '',
): Promise<IngestResult> {
  const { client, userId } = await getClient();
  return client.ingest({
    user_query: text,
    agent_response: agentResponse,
    user_id: userId,
  });
}

export async function searchMemories(
  query: string,
  opts: { domains?: string[]; topK?: number } = {},
): Promise<SourceRecord[]> {
  const { client, userId } = await getClient();
  const result = await client.search({
    query,
    user_id: userId,
    domains: opts.domains || ['profile', 'temporal', 'summary'],
    top_k: opts.topK || 10,
  });
  return result.results;
}

export async function retrieveAnswer(
  query: string,
  opts: { topK?: number } = {},
): Promise<RetrieveResult> {
  const { client, userId } = await getClient();
  return client.retrieve({
    query,
    user_id: userId,
    top_k: opts.topK || 5,
  });
}

export async function checkHealth(): Promise<boolean> {
  try {
    const { client } = await getClient();
    return await client.isReady();
  } catch {
    return false;
  }
}

export async function getHealthStatus(): Promise<HealthStatus> {
  const { client } = await getClient();
  return client.ping();
}

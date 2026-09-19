import { fetch } from 'undici';

import type { Config } from '../../../shared/config.js';
import { ensure } from '../../../shared/errors.js';
import { object, strictJson } from '../../../shared/json.js';
import { boundedText } from '../../../shared/network.js';
import type { Row } from '../../../shared/types/entities.js';

const AGENT_ID = 'support-knowledge';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PAGE_SIZE = 250;
const MAX_ENUMERATED = 100000;

/** The external long-term memory service; injected in tests. */
export interface MemoryTransport {
  remember(content: string, project: string, concepts: string[]): Promise<Row>;
  get(id: string): Promise<Row | null>;
  search(query: string): Promise<string[]>;
  list(): Promise<Row[]>;
  forget(id: string): Promise<void>;
}

/** HTTP client for the agentmemory service. */
export class AgentMemoryClient implements MemoryTransport {
  constructor(private readonly config: Config) {}

  async remember(content: string, project: string, concepts: string[]): Promise<Row> {
    const result = await this.request('/agentmemory/remember', {
      content,
      type: 'workflow',
      concepts,
      project,
      agentId: AGENT_ID,
      ttlDays: 180,
    });
    ensure(result?.success === true, 'memory_write_unknown', 503);
    return object(result.memory);
  }

  async get(id: string): Promise<Row | null> {
    const result = await this.request(`/agentmemory/memories/${encodeURIComponent(id)}`);
    return result ? object(result.memory) : null;
  }

  /** Upstream ids of matching memories (only ids of this service's `mem_` records). */
  async search(query: string): Promise<string[]> {
    const result = await this.request('/agentmemory/smart-search', {
      query: query.slice(0, 2000),
      limit: 20,
      includeLessons: false,
      agentId: AGENT_ID,
    });
    ensure(Array.isArray(result?.results), 'invalid_memory_response', 503);
    return (result.results as unknown[])
      .map((item) => object(item).obsId)
      .filter((id): id is string => typeof id === 'string' && id.startsWith('mem_'));
  }

  /** Every memory of this agent, paged; fails if the total changes while paging. */
  async list(): Promise<Row[]> {
    const all: Row[] = [];
    let total: number | undefined;
    for (;;) {
      const result = await this.request(
        `/agentmemory/memories?agentId=${AGENT_ID}&limit=${PAGE_SIZE}&offset=${all.length}`,
      );
      ensure(
        Array.isArray(result?.memories) && Number.isInteger(result.total),
        'invalid_memory_enumeration',
        503,
      );
      ensure(total === undefined || total === result.total, 'unstable_memory_enumeration', 503);
      total = Number(result.total);
      const page = (result.memories as unknown[]).map(object);
      all.push(...page);
      if (all.length >= total) {
        return all;
      }
      ensure(page.length > 0 && all.length < MAX_ENUMERATED, 'memory_enumeration_limit', 503);
    }
  }

  async forget(id: string): Promise<void> {
    const result = await this.request('/agentmemory/forget', { memoryId: id });
    ensure(result?.success === true, 'memory_delete_failed', 503);
  }

  /** GET when there is no body. A GET answered 404 means "no such memory" (null). */
  private async request(path: string, body?: Row): Promise<Row | null> {
    const response = await fetch(new URL(path, this.config.AGENTMEMORY_URL), {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.config.AGENTMEMORY_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (response.status === 404 && !body) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('memory_unavailable');
    }
    const result = object(
      strictJson(await boundedText(response, MAX_RESPONSE_BYTES), false, MAX_RESPONSE_BYTES),
    );
    if (result.success === false) {
      throw new Error('memory_rejected');
    }
    return result;
  }
}

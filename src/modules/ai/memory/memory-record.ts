import type { Config } from '../../../shared/config.js';
import type { Database } from '../../../shared/db.js';
import type { Resolution } from '../../../shared/types/ai.js';
import type { Row } from '../../../shared/types/entities.js';

import type { MemoryTransport } from './agent-memory-client.js';

/** A learned resolution: stored locally first, then written to the external memory service. */
export type MemoryRecord = Row & {
  id: string;
  ticket_id: string;
  closure_id: string;
  source_key: string;
  content_hash: string;
  content: Resolution;
  state: string;
  eligible: boolean;
  upstream_id: string | null;
  write_generation: number;
};

/** What triage may show the model about a past case. */
export type CaseEvidence = {
  id: string;
  problem_summary: string;
  solution_summary: string | null;
  applicability: string[];
  cautions: string[];
};

/** Retrieval of resolved cases, as the triage tools use it. */
export interface Recall {
  search(query: string): Promise<CaseEvidence[]>;
  expand(ids: string[]): Promise<CaseEvidence[]>;
}

export interface MemoryDeps {
  db: Database;
  config: Config;
  upstream: MemoryTransport;
}

export const RECORD_JOINS = `FROM memory_records r JOIN closures cl ON cl.id=r.closure_id
  JOIN tickets t ON t.id=r.ticket_id JOIN clients c ON c.id=t.client_id`;

/**
 * The upstream copy of a record. The source key and content hash lines let reconciliation
 * recognise a write whose outcome was unknown.
 */
export function serializeRecord(record: MemoryRecord): string {
  const { content, source_key: sourceKey, content_hash: contentHash } = record;
  return `${JSON.stringify(content)}\nSOURCE_KEY=${sourceKey}\nCONTENT_HASH=${contentHash}`;
}

export function toEvidence(record: MemoryRecord): CaseEvidence {
  return {
    id: record.id,
    problem_summary: record.content.problem_summary,
    solution_summary: record.content.solution_summary,
    applicability: record.content.applicability,
    cautions: record.content.cautions,
  };
}

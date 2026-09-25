import type { Config } from '../../../shared/config.js';
import type { Database } from '../../../shared/db.js';
import type { Resolution } from '../../../shared/types/ai.js';
import type { Row } from '../../../shared/types/entities.js';

import type { MemoryTransport } from './agent-memory-client.js';

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

export type CaseEvidence = {
  id: string;
  problem_summary: string;
  solution_summary: string | null;
  applicability: string[];
  cautions: string[];
};

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

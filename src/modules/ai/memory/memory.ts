import type { Config } from '../../../shared/config.js';
import type { Database } from '../../../shared/db.js';

import { AgentMemoryClient, type MemoryTransport } from './agent-memory-client.js';
import {
  RECORD_JOINS,
  toEvidence,
  type CaseEvidence,
  type MemoryDeps,
  type MemoryRecord,
  type Recall,
} from './memory-record.js';
import { persistMemory } from './persist.js';
import { reconcileMemory } from './reconcile.js';
import { removeMemory } from './remove.js';

/** A record may be recalled only while its case is closed, not reopened, and consented. */
const RECALLABLE = `r.org_id=$1 AND r.eligible AND r.state='persisted' AND r.expires_at>now()
  AND NOT cl.invalidated AND t.current_cycle_id=cl.id AND t.lifecycle=cl.lifecycle
  AND c.consent_state='granted' AND c.consent_revision=t.consent_revision`;

/**
 * Long-term memory of resolved cases. Upstream search only proposes candidates; every result
 * is re-checked against local records, so withdrawn or reopened cases are never recalled.
 */
export class Memory implements Recall {
  private readonly deps: MemoryDeps;

  constructor(
    db: Database,
    config: Config,
    upstream: MemoryTransport = new AgentMemoryClient(config),
  ) {
    this.deps = { db, config, upstream };
  }

  async search(query: string): Promise<CaseEvidence[]> {
    if (!this.deps.config.MEMORY_ENABLED) {
      return [];
    }
    const ids = await this.deps.upstream.search(query);
    if (!ids.length) {
      return [];
    }
    return this.recallable('r.upstream_id=ANY($2::text[])', ids);
  }

  /** Re-reads cases by local id (the ids the model cites). */
  async expand(ids: string[]): Promise<CaseEvidence[]> {
    if (!this.deps.config.MEMORY_ENABLED || !ids.length) {
      return [];
    }
    return this.recallable('r.id=ANY($2::uuid[])', ids);
  }

  async persist(id: string): Promise<void> {
    await persistMemory(this.deps, id);
  }

  async reconcile(id: string): Promise<void> {
    await reconcileMemory(this.deps, id);
  }

  async remove(id: string): Promise<void> {
    await removeMemory(this.deps, id);
  }

  private async recallable(filter: string, ids: string[]): Promise<CaseEvidence[]> {
    const { rows } = await this.deps.db.query<MemoryRecord>(
      `SELECT r.* ${RECORD_JOINS} WHERE ${RECALLABLE} AND ${filter} LIMIT 5`,
      [this.deps.config.ORG_ID, ids],
    );
    return rows.map(toEvidence);
  }
}

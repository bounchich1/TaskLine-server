import { fetch } from 'undici';

import type { Config } from '../config.js';
import { one, type Database } from '../db.js';
import { AppError, ensure } from '../errors.js';
import { emit } from '../events.js';
import { object, strictJson } from '../json.js';
import { boundedText } from '../network.js';
import type { Resolution, Row } from '../types.js';

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
export interface MemoryTransport {
  remember(content: string, project: string, concepts: string[]): Promise<Row>;
  get(id: string): Promise<Row | null>;
  search(query: string): Promise<string[]>;
  list(): Promise<Row[]>;
  forget(id: string): Promise<void>;
}
export class AgentMemoryClient implements MemoryTransport {
  constructor(readonly c: Config) {}
  async request(path: string, body?: Row): Promise<Row | null> {
    const response = await fetch(new URL(path, this.c.AGENTMEMORY_URL), {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.c.AGENTMEMORY_SECRET}`,
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
      strictJson(await boundedText(response, 4 * 1024 * 1024), false, 4 * 1024 * 1024),
    );
    if (result.success === false) {
      throw new Error('memory_rejected');
    }
    return result;
  }
  async remember(content: string, project: string, concepts: string[]) {
    const result = await this.request('/agentmemory/remember', {
      content,
      type: 'workflow',
      concepts,
      project,
      agentId: 'support-knowledge',
      ttlDays: 180,
    });
    ensure(result?.success === true, 'memory_write_unknown', 503);
    return object(result.memory);
  }
  async get(id: string) {
    const result = await this.request(`/agentmemory/memories/${encodeURIComponent(id)}`);
    return result ? object(result.memory) : null;
  }
  async search(query: string) {
    const result = await this.request('/agentmemory/smart-search', {
      query: query.slice(0, 2000),
      limit: 20,
      includeLessons: false,
      agentId: 'support-knowledge',
    });
    ensure(Array.isArray(result?.results), 'invalid_memory_response', 503);
    return result.results
      .map((item) => object(item).obsId)
      .filter((id): id is string => typeof id === 'string' && id.startsWith('mem_'));
  }
  async list() {
    const all: Row[] = [];
    let offset = 0;
    let total: number | undefined;
    for (;;) {
      const result = await this.request(
        `/agentmemory/memories?agentId=support-knowledge&limit=250&offset=${offset}`,
      );
      ensure(
        Array.isArray(result?.memories) && Number.isInteger(result.total),
        'invalid_memory_enumeration',
        503,
      );
      if (total !== undefined) {
        ensure(total === result.total, 'unstable_memory_enumeration', 503);
      }
      total = Number(result.total);
      const page = result.memories.map(object);
      all.push(...page);
      offset += page.length;
      if (offset >= total) {
        return all;
      }
      ensure(page.length > 0 && offset < 100000, 'memory_enumeration_limit', 503);
    }
  }
  async forget(id: string) {
    const result = await this.request('/agentmemory/forget', { memoryId: id });
    ensure(result?.success === true, 'memory_delete_failed', 503);
  }
}
const eligibility = `r.org_id=$1 AND r.eligible AND r.state='persisted' AND r.expires_at>now()
  AND NOT cl.invalidated AND t.current_cycle_id=cl.id AND t.lifecycle=cl.lifecycle
  AND c.consent_state='granted' AND c.consent_revision=t.consent_revision`;
const joins =
  'FROM memory_records r JOIN closures cl ON cl.id=r.closure_id JOIN tickets t ON t.id=r.ticket_id JOIN clients c ON c.id=t.client_id';
export class Memory implements Recall {
  constructor(
    readonly db: Database,
    readonly c: Config,
    readonly upstream: MemoryTransport = new AgentMemoryClient(c),
  ) {}
  async search(query: string): Promise<CaseEvidence[]> {
    if (!this.c.MEMORY_ENABLED) {
      return [];
    }
    const ids = await this.upstream.search(query);
    if (!ids.length) {
      return [];
    }
    const rows = (
      await this.db.query<MemoryRecord>(
        `SELECT r.* ${joins} WHERE ${eligibility} AND r.upstream_id=ANY($2::text[]) LIMIT 5`,
        [this.c.ORG_ID, ids],
      )
    ).rows;
    return rows.map((r) => this.evidence(r));
  }
  async expand(ids: string[]): Promise<CaseEvidence[]> {
    if (!this.c.MEMORY_ENABLED || !ids.length) {
      return [];
    }
    const rows = (
      await this.db.query<MemoryRecord>(
        `SELECT r.* ${joins} WHERE ${eligibility} AND r.id=ANY($2::uuid[]) LIMIT 5`,
        [this.c.ORG_ID, ids],
      )
    ).rows;
    return rows.map((r) => this.evidence(r));
  }
  private evidence(r: MemoryRecord): CaseEvidence {
    return {
      id: r.id,
      problem_summary: r.content.problem_summary,
      solution_summary: r.content.solution_summary,
      applicability: r.content.applicability,
      cautions: r.content.cautions,
    };
  }
  private serialize(r: MemoryRecord) {
    return `${JSON.stringify(r.content)}\nSOURCE_KEY=${r.source_key}\nCONTENT_HASH=${r.content_hash}`;
  }
  async persist(id: string) {
    if (!this.c.MEMORY_ENABLED) {
      throw new AppError('memory_disabled', 503);
    }
    const record = await this.db.tx(async (tx) => {
      const row = await one<MemoryRecord>(
        tx,
        'SELECT * FROM memory_records WHERE org_id=$1 AND id=$2 FOR UPDATE',
        [this.c.ORG_ID, id],
      );
      ensure(row, 'not_found', 404);
      if (['persisted', 'deleted'].includes(row.state)) {
        return null;
      }
      const live = await one(
        tx,
        `SELECT r.id ${joins} WHERE r.id=$2 AND r.org_id=$1 AND NOT cl.invalidated AND t.current_cycle_id=cl.id AND c.consent_state='granted' AND c.consent_revision=t.consent_revision`,
        [this.c.ORG_ID, id],
      );
      if (!live) {
        await tx.query("UPDATE memory_records SET eligible=false,state='invalidated' WHERE id=$1", [
          id,
        ]);
        return null;
      }
      if (['writing', 'write_unknown'].includes(row.state)) {
        throw new AppError('memory_write_unknown', 409);
      }
      const lock = await one(
        tx,
        'UPDATE memory_writer SET holder=$2,started_at=now() WHERE org_id=$1 AND (holder IS NULL OR holder=$2) RETURNING org_id',
        [this.c.ORG_ID, id],
      );
      ensure(lock, 'memory_writer_busy', 429);
      return (await one<MemoryRecord>(
        tx,
        "UPDATE memory_records SET state=CASE WHEN upstream_id IS NULL THEN 'writing' ELSE 'persisted_index_pending' END,write_generation=write_generation+1 WHERE id=$1 RETURNING *",
        [id],
      ))!;
    });
    if (!record) {
      return;
    }
    let external: Row;
    let upstreamId = record.upstream_id;
    try {
      if (!upstreamId) {
        external = await this.upstream.remember(
          this.serialize(record),
          `support_${this.c.ORG_ID}_${record.closure_id}`,
          [],
        );
        ensure(typeof external.id === 'string', 'memory_write_unknown', 503);
        upstreamId = external.id;
        await this.db.tx(async (tx) => {
          await tx.query(
            "UPDATE memory_records SET upstream_id=$2,state='persisted_index_pending' WHERE id=$1 AND write_generation=$3",
            [id, upstreamId, record.write_generation],
          );
          for (const ref of [
            upstreamId,
            ...(Array.isArray(external.supersedes) ? external.supersedes : []),
          ]) {
            if (typeof ref === 'string') {
              await tx.query(
                'INSERT INTO memory_external_refs(record_id,upstream_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
                [id, ref],
              );
            }
          }
        });
      }
      const readBack = await this.upstream.get(upstreamId);
      ensure(readBack?.content === this.serialize(record), 'memory_readback_mismatch', 503);
      const indexed = (await this.upstream.search(record.source_key)).includes(upstreamId);
      await this.db.tx(async (tx) => {
        const live = await one(
          tx,
          `SELECT r.id ${joins} WHERE r.org_id=$1 AND r.id=$2 AND NOT cl.invalidated AND t.current_cycle_id=cl.id AND c.consent_state='granted' AND c.consent_revision=t.consent_revision`,
          [this.c.ORG_ID, id],
        );
        await tx.query(
          'UPDATE memory_records SET state=$2,eligible=eligible AND $3 WHERE id=$1 AND write_generation=$4',
          [id, indexed ? 'persisted' : 'persisted_index_pending', !!live, record.write_generation],
        );
        await tx.query('UPDATE closures SET learning_status=$2 WHERE id=$1 AND NOT invalidated', [
          record.closure_id,
          indexed ? 'learned' : 'persistence_pending',
        ]);
        await tx.query('UPDATE memory_writer SET holder=NULL WHERE org_id=$1 AND holder=$2', [
          this.c.ORG_ID,
          id,
        ]);
        await emit(tx, this.c.ORG_ID, 'learning.changed', record.ticket_id, {
          state: indexed ? 'learned' : 'persistence_pending',
        });
      });
      if (!indexed) {
        throw new AppError('memory_index_pending', 503);
      }
    } catch (error) {
      if (!upstreamId) {
        await this.db.query(
          "UPDATE memory_records SET state='write_unknown',reason='write_outcome_unknown' WHERE id=$1 AND write_generation=$2",
          [id, record.write_generation],
        );
      } else {
        await this.db.query('UPDATE memory_writer SET holder=NULL WHERE org_id=$1 AND holder=$2', [
          this.c.ORG_ID,
          id,
        ]);
      }
      throw error;
    }
  }
  async reconcile(id: string) {
    const record = await one<MemoryRecord>(
      this.db,
      'SELECT * FROM memory_records WHERE org_id=$1 AND id=$2',
      [this.c.ORG_ID, id],
    );
    ensure(record, 'not_found', 404);
    ensure(['write_unknown', 'writing'].includes(record.state), 'reconcile_not_required');
    const all = await this.upstream.list();
    const matches = all.filter(
      (m) => typeof m.content === 'string' && m.content.includes(`SOURCE_KEY=${record.source_key}`),
    );
    // Absence cannot establish a timed-out writer will not commit later. Never auto-repeat remember.
    ensure(matches.length > 0, 'memory_still_unknown', 409);
    ensure(
      matches.every((m) => m.content === this.serialize(record)),
      'memory_hash_conflict',
    );
    await this.db.tx(async (tx) => {
      for (const m of matches) {
        await tx.query(
          'INSERT INTO memory_external_refs(record_id,upstream_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [id, m.id],
        );
      }
      await tx.query(
        "UPDATE memory_records SET upstream_id=$2,state='persisted_index_pending' WHERE id=$1",
        [id, matches[0].id],
      );
      await tx.query('UPDATE memory_writer SET holder=NULL WHERE org_id=$1 AND holder=$2', [
        this.c.ORG_ID,
        id,
      ]);
    });
    await this.persist(id);
  }
  async remove(id: string) {
    if (!this.c.MEMORY_ENABLED) {
      throw new AppError('memory_disabled', 503);
    }
    const record = await one<MemoryRecord>(
      this.db,
      'SELECT * FROM memory_records WHERE org_id=$1 AND id=$2',
      [this.c.ORG_ID, id],
    );
    if (!record) {
      return;
    }
    await this.db.query('UPDATE memory_records SET eligible=false WHERE id=$1', [id]);
    if (['writing', 'write_unknown'].includes(record.state)) {
      await this.reconcile(id);
    }
    const refs = (
      await this.db.query(
        'SELECT upstream_id FROM memory_external_refs WHERE record_id=$1 AND deleted_at IS NULL',
        [id],
      )
    ).rows;
    for (const ref of refs) {
      await this.upstream.forget(String(ref.upstream_id));
      ensure(
        (await this.upstream.get(String(ref.upstream_id))) === null,
        'memory_delete_unverified',
        503,
      );
      await this.db.query(
        'UPDATE memory_external_refs SET deleted_at=now() WHERE record_id=$1 AND upstream_id=$2',
        [id, ref.upstream_id],
      );
    }
    await this.db.query("UPDATE memory_records SET state='deleted',eligible=false WHERE id=$1", [
      id,
    ]);
  }
}

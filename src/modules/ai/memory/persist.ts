import { one, requireOne, type Sql } from '../../../shared/db.js';
import { AppError, ensure } from '../../../shared/errors.js';
import { emit } from '../../../shared/events.js';

import {
  RECORD_JOINS,
  serializeRecord,
  type MemoryDeps,
  type MemoryRecord,
} from './memory-record.js';

/**
 * Writes a memory record to the external memory service and verifies it: read back, then
 * indexed for search. One writer per organization at a time. A write whose outcome is unknown
 * is never repeated automatically (see reconcileMemory).
 */
export async function persistMemory(deps: MemoryDeps, id: string): Promise<void> {
  if (!deps.config.MEMORY_ENABLED) {
    throw new AppError('memory_disabled', 503);
  }
  const record = await deps.db.tx(async (tx) => claimWrite(tx, deps, id));
  if (!record) {
    return;
  }
  let upstreamId = record.upstream_id;
  try {
    if (!upstreamId) {
      const written = await writeUpstream(deps, record);
      // From here on the write is known to exist upstream, even if recording it fails.
      upstreamId = written.id;
      await recordUpstream(deps, record, written);
    }
    await verifyAndFinalize(deps, record, upstreamId);
  } catch (error) {
    await releaseAfterFailure(deps, record, upstreamId);
    throw error;
  }
}

/** Marks the record as being written and takes the writer lock; null if nothing to do. */
async function claimWrite(
  tx: Sql,
  { config }: MemoryDeps,
  id: string,
): Promise<MemoryRecord | null> {
  const org = config.ORG_ID;
  const row = await one<MemoryRecord>(
    tx,
    'SELECT * FROM memory_records WHERE org_id=$1 AND id=$2 FOR UPDATE',
    [org, id],
  );
  ensure(row, 'not_found', 404);
  if (['persisted', 'deleted'].includes(row.state)) {
    return null;
  }
  const live = await one(
    tx,
    `SELECT r.id ${RECORD_JOINS} WHERE r.id=$2 AND r.org_id=$1 AND NOT cl.invalidated
     AND t.current_cycle_id=cl.id AND c.consent_state='granted' AND c.consent_revision=t.consent_revision`,
    [org, id],
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
    `UPDATE memory_writer SET holder=$2,started_at=now()
     WHERE org_id=$1 AND (holder IS NULL OR holder=$2) RETURNING org_id`,
    [org, id],
  );
  ensure(lock, 'memory_writer_busy', 429);
  return requireOne<MemoryRecord>(
    tx,
    `UPDATE memory_records SET state=CASE WHEN upstream_id IS NULL THEN 'writing'
     ELSE 'persisted_index_pending' END,write_generation=write_generation+1 WHERE id=$1 RETURNING *`,
    [id],
  );
}

interface UpstreamWrite {
  id: string;
  /** Older upstream memories the service merged into this one. */
  superseded: unknown[];
}

async function writeUpstream(
  { config, upstream }: MemoryDeps,
  record: MemoryRecord,
): Promise<UpstreamWrite> {
  const project = `support_${config.ORG_ID}_${record.closure_id}`;
  const external = await upstream.remember(serializeRecord(record), project, []);
  ensure(typeof external.id === 'string', 'memory_write_unknown', 503);
  const superseded = Array.isArray(external.supersedes) ? (external.supersedes as unknown[]) : [];
  return { id: external.id, superseded };
}

/** Stores the upstream id, and every upstream id to delete if the record is ever removed. */
async function recordUpstream(
  { db }: MemoryDeps,
  record: MemoryRecord,
  written: UpstreamWrite,
): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query(
      `UPDATE memory_records SET upstream_id=$2,state='persisted_index_pending'
       WHERE id=$1 AND write_generation=$3`,
      [record.id, written.id, record.write_generation],
    );
    for (const ref of [written.id, ...written.superseded]) {
      if (typeof ref === 'string') {
        await recordExternalRef(tx, record.id, ref);
      }
    }
  });
}

export async function recordExternalRef(tx: Sql, recordId: string, upstreamId: unknown) {
  await tx.query(
    `INSERT INTO memory_external_refs(record_id,upstream_id) VALUES($1,$2)
     ON CONFLICT DO NOTHING`,
    [recordId, upstreamId],
  );
}

/**
 * Checks the upstream copy byte for byte, then whether search finds it yet. Not indexed yet:
 * the record stays pending and the job retries (`memory_index_pending`).
 */
async function verifyAndFinalize(
  { db, config, upstream }: MemoryDeps,
  record: MemoryRecord,
  upstreamId: string,
): Promise<void> {
  const readBack = await upstream.get(upstreamId);
  ensure(readBack?.content === serializeRecord(record), 'memory_readback_mismatch', 503);
  const indexed = (await upstream.search(record.source_key)).includes(upstreamId);
  await db.tx(async (tx) => {
    await finalizeRecord(tx, config.ORG_ID, { record, indexed });
  });
  if (!indexed) {
    throw new AppError('memory_index_pending', 503);
  }
}

async function finalizeRecord(
  tx: Sql,
  org: string,
  { record, indexed }: { record: MemoryRecord; indexed: boolean },
): Promise<void> {
  // Consent may have been withdrawn or the ticket reopened while writing.
  const live = await one(
    tx,
    `SELECT r.id ${RECORD_JOINS} WHERE r.org_id=$1 AND r.id=$2 AND NOT cl.invalidated
     AND t.current_cycle_id=cl.id AND c.consent_state='granted' AND c.consent_revision=t.consent_revision`,
    [org, record.id],
  );
  await tx.query(
    `UPDATE memory_records SET state=$2,eligible=eligible AND $3
     WHERE id=$1 AND write_generation=$4`,
    [record.id, indexed ? 'persisted' : 'persisted_index_pending', !!live, record.write_generation],
  );
  const learningStatus = indexed ? 'learned' : 'persistence_pending';
  await tx.query('UPDATE closures SET learning_status=$2 WHERE id=$1 AND NOT invalidated', [
    record.closure_id,
    learningStatus,
  ]);
  await releaseWriter(tx, org, record.id);
  await emit(tx, org, 'learning.changed', record.ticket_id, { state: learningStatus });
}

/** Without an upstream id the write may or may not have happened: mark it unknown. */
async function releaseAfterFailure(
  { db, config }: MemoryDeps,
  record: MemoryRecord,
  upstreamId: string | null,
): Promise<void> {
  if (!upstreamId) {
    await db.query(
      `UPDATE memory_records SET state='write_unknown',reason='write_outcome_unknown'
       WHERE id=$1 AND write_generation=$2`,
      [record.id, record.write_generation],
    );
  } else {
    await releaseWriter(db, config.ORG_ID, record.id);
  }
}

export async function releaseWriter(db: Sql, org: string, recordId: string): Promise<void> {
  await db.query('UPDATE memory_writer SET holder=NULL WHERE org_id=$1 AND holder=$2', [
    org,
    recordId,
  ]);
}

import { one } from '../../../shared/db.js';
import { AppError, ensure } from '../../../shared/errors.js';

import type { MemoryDeps, MemoryRecord } from './memory-record.js';
import { reconcileMemory } from './reconcile.js';

export async function removeMemory(deps: MemoryDeps, id: string): Promise<void> {
    const { db, config, upstream } = deps;

    if (!config.MEMORY_ENABLED) {
        throw new AppError('memory_disabled', 503);
    }

    const record = await one<MemoryRecord>(db, 'SELECT * FROM memory_records WHERE org_id=$1 AND id=$2', [
        config.ORG_ID,
        id,
    ]);

    if (!record) {
        return;
    }

    await db.query('UPDATE memory_records SET eligible=false WHERE id=$1', [id]);

    if (['writing', 'write_unknown'].includes(record.state)) {
        await reconcileMemory(deps, id);
    }

    const { rows: refs } = await db.query<{ upstream_id: string }>(
        'SELECT upstream_id FROM memory_external_refs WHERE record_id=$1 AND deleted_at IS NULL',
        [id],
    );

    for (const { upstream_id: upstreamId } of refs) {
        await upstream.forget(upstreamId);
        ensure((await upstream.get(upstreamId)) === null, 'memory_delete_unverified', 503);

        await db.query('UPDATE memory_external_refs SET deleted_at=now() WHERE record_id=$1 AND upstream_id=$2', [
            id,
            upstreamId,
        ]);
    }

    await db.query("UPDATE memory_records SET state='deleted',eligible=false WHERE id=$1", [id]);
}

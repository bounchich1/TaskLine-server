import { one } from '../../../shared/db.js';
import { ensure } from '../../../shared/errors.js';

import { serializeRecord, type MemoryDeps, type MemoryRecord } from './memory-record.js';
import { persistMemory, recordExternalRef, releaseWriter } from './persist.js';

export async function reconcileMemory(deps: MemoryDeps, id: string): Promise<void> {
    const { db, config, upstream } = deps;
    const org = config.ORG_ID;
    const record = await one<MemoryRecord>(db, 'SELECT * FROM memory_records WHERE org_id=$1 AND id=$2', [org, id]);

    ensure(record, 'not_found', 404);
    ensure(['write_unknown', 'writing'].includes(record.state), 'reconcile_not_required');
    const all = await upstream.list();

    const matches = all.filter(
        (memory) => typeof memory.content === 'string' && memory.content.includes(`SOURCE_KEY=${record.source_key}`),
    );

    const [first] = matches;

    ensure(first, 'memory_still_unknown', 409);

    ensure(
        matches.every((memory) => memory.content === serializeRecord(record)),
        'memory_hash_conflict',
    );

    await db.tx(async (tx) => {
        for (const memory of matches) {
            await recordExternalRef(tx, id, memory.id);
        }

        await tx.query("UPDATE memory_records SET upstream_id=$2,state='persisted_index_pending' WHERE id=$1", [
            id,
            first.id,
        ]);

        await releaseWriter(tx, org, id);
    });

    await persistMemory(deps, id);
}

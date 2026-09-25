import type { Ctx } from '../../shared/context.js';
import { encrypt } from '../../shared/crypto.js';
import { requireOne, type Sql } from '../../shared/db.js';
import type { ClientInput } from '../../shared/types/client-input.js';
import type { Client, Row } from '../../shared/types/entities.js';

const MAX_BUFFERED_MESSAGES = 5;
const MAX_BUFFERED_BYTES = 65536;

export type PreconsentBuffer = Row & { payload: string; expires_at: string; created_at: string };

export async function bufferPreconsentInput(tx: Sql, ctx: Ctx, client: Client, input: ClientInput): Promise<boolean> {
    const bytes = Buffer.byteLength(JSON.stringify(input));

    const size = await requireOne(
        tx,
        `SELECT count(*)::int AS n,coalesce(sum(byte_count),0)::int AS bytes
     FROM preconsent_buffers WHERE client_id=$1`,
        [client.id],
    );

    if (Number(size.n) >= MAX_BUFFERED_MESSAGES || Number(size.bytes) + bytes > MAX_BUFFERED_BYTES) {
        return false;
    }

    await tx.query(
        `INSERT INTO preconsent_buffers(org_id,client_id,source_key,payload,byte_count)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [ctx.org, client.id, input.sourceKey, encrypt(input, ctx.config.ENCRYPTION_KEY), bytes],
    );

    return true;
}

export async function listPreconsentBuffers(tx: Sql, clientId: string): Promise<PreconsentBuffer[]> {
    const result = await tx.query<PreconsentBuffer>(
        'SELECT * FROM preconsent_buffers WHERE client_id=$1 ORDER BY created_at,id',
        [clientId],
    );

    return result.rows;
}

export async function clearPreconsentBuffers(tx: Sql, clientId: string): Promise<void> {
    await tx.query('DELETE FROM preconsent_buffers WHERE client_id=$1', [clientId]);
}

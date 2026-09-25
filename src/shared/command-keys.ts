import { requireOne, type Sql } from './db.js';
import { ensure } from './errors.js';
import type { Row } from './types/entities.js';

export interface CommandKey {
    principal: string;
    route: string;
    key: string;
}

export async function claimCommandKey(
    tx: Sql,
    commandKey: CommandKey,
    requestHash: string,
): Promise<{ response: unknown }> {
    const { principal, route, key } = commandKey;

    await tx.query(
        `INSERT INTO command_keys(principal,route,key,request_hash)
     VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [principal, route, key, requestHash],
    );

    const claimed = await requireOne<Row & { request_hash: string }>(
        tx,
        'SELECT * FROM command_keys WHERE principal=$1 AND route=$2 AND key=$3 FOR UPDATE',
        [principal, route, key],
    );

    ensure(claimed.request_hash === requestHash, 'idempotency_conflict');

    return { response: claimed.response };
}

export async function saveCommandResponse(
    tx: Sql,
    { principal, route, key }: CommandKey,
    response: unknown,
): Promise<void> {
    await tx.query('UPDATE command_keys SET response=$4 WHERE principal=$1 AND route=$2 AND key=$3', [
        principal,
        route,
        key,
        JSON.stringify(response),
    ]);
}

import { z } from 'zod';

import { can } from '../../shared/access.js';
import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Employee } from '../../shared/types/entities.js';

const code = z.string().regex(/^[a-z][a-z0-9_]*$/);

const actions = z
    .object({
        tag: code.optional(),
        urgency: code.optional(),
        complexity: code.optional(),
        wait: z.boolean().optional(),
        close: z.boolean().optional(),
    })
    .strict()
    .refine((value) => !(value.wait && value.close), 'wait and close are exclusive');

export const macroBody = z
    .object({
        title: z.string().trim().min(1).max(80),
        body: z.string().trim().min(1).max(4000),
        actions: actions.default({}),
        shared: z.boolean().default(false),
    })
    .strict();

export type MacroBody = z.infer<typeof macroBody>;
export type MacroActions = z.infer<typeof actions>;

export interface Macro extends Record<string, unknown> {
    id: string;
    owner_id: string | null;
    title: string;
    body: string;
    actions: MacroActions;
    uses: number;
    version: number;
}

const COLUMNS = 'id,owner_id,title,body,actions,uses,version,owner_id IS NULL AS shared';
const SHARED_FORBIDDEN = 'Общие шаблоны может менять только администратор.';

export async function listMacros(db: Sql, org: string, actor: Employee) {
    const { rows } = await db.query(
        `SELECT ${COLUMNS} FROM macros WHERE org_id=$1 AND (owner_id IS NULL OR owner_id=$2)
     ORDER BY owner_id IS NULL DESC,uses DESC,lower(title)`,
        [org, actor.id],
    );

    return { items: rows };
}

async function assertKnownActions(tx: Sql, org: string, body: MacroBody): Promise<void> {
    for (const dimension of ['tag', 'urgency', 'complexity'] as const) {
        const value = body.actions[dimension];

        if (value) {
            const entry = await one(
                tx,
                'SELECT code FROM dictionaries WHERE org_id=$1 AND dimension=$2 AND code=$3 AND active',
                [org, dimension, value],
            );

            ensure(entry, 'invalid_dictionary', 422, `Неизвестное значение «${value}».`);
        }
    }
}

export async function createMacro(tx: Sql, org: string, actor: Employee, body: MacroBody) {
    ensure(!body.shared || can(actor, 'organization.configure'), 'forbidden', 403, SHARED_FORBIDDEN);
    await assertKnownActions(tx, org, body);

    return one(
        tx,
        `INSERT INTO macros(org_id,owner_id,title,body,actions) VALUES($1,$2,$3,$4,$5) RETURNING ${COLUMNS}`,
        [org, body.shared ? null : actor.id, body.title, body.body, JSON.stringify(body.actions)],
    );
}

async function lockEditable(tx: Sql, org: string, actor: Employee, change: { id: string; expectedVersion: number }) {
    const macro = await one<Macro>(tx, 'SELECT * FROM macros WHERE org_id=$1 AND id=$2 FOR UPDATE', [org, change.id]);

    ensure(macro && (macro.owner_id === null || macro.owner_id === actor.id), 'not_found', 404);
    ensure(macro.owner_id !== null || can(actor, 'organization.configure'), 'forbidden', 403, SHARED_FORBIDDEN);
    ensure(macro.version === change.expectedVersion, 'version_conflict', 409, 'Шаблон изменился. Обновите список.');

    return macro;
}

export async function updateMacro(
    tx: Sql,
    org: string,
    actor: Employee,
    change: { id: string; body: MacroBody; expectedVersion: number },
) {
    await lockEditable(tx, org, actor, change);
    ensure(!change.body.shared || can(actor, 'organization.configure'), 'forbidden', 403, SHARED_FORBIDDEN);
    await assertKnownActions(tx, org, change.body);

    return one(
        tx,
        `UPDATE macros SET owner_id=$3,title=$4,body=$5,actions=$6,version=version+1,updated_at=now()
     WHERE org_id=$1 AND id=$2 RETURNING ${COLUMNS}`,
        [
            org,
            change.id,
            change.body.shared ? null : actor.id,
            change.body.title,
            change.body.body,
            JSON.stringify(change.body.actions),
        ],
    );
}

export async function deleteMacro(
    tx: Sql,
    org: string,
    actor: Employee,
    change: { id: string; expectedVersion: number },
) {
    await lockEditable(tx, org, actor, change);
    await tx.query('DELETE FROM macros WHERE org_id=$1 AND id=$2', [org, change.id]);

    return { id: change.id, deleted: true };
}

export async function useMacro(tx: Sql, org: string, actor: Employee, macroId: string): Promise<Macro> {
    const macro = await one<Macro>(
        tx,
        `UPDATE macros SET uses=uses+1 WHERE org_id=$1 AND id=$2 AND (owner_id IS NULL OR owner_id=$3)
     RETURNING ${COLUMNS}`,
        [org, macroId, actor.id],
    );

    ensure(macro, 'macro_not_found', 422, 'Шаблон ответа не найден.');

    return macro;
}

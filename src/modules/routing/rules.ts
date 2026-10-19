import { z } from 'zod';

import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

const DIMENSIONS = ['tag', 'urgency', 'complexity'] as const;

const codes = z
    .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
    .max(100)
    .default([]);

const ruleBody = z
    .object({
        team_id: z.uuid(),
        match: z.object({ tag: codes, urgency: codes, complexity: codes }).strict(),
    })
    .strict();

export const rulesBody = z.object({ rules: z.array(ruleBody).max(100) }).strict();

export type RulesBody = z.infer<typeof rulesBody>;

const dimensionMatches = (dimension: string, parameter: string) =>
    `(coalesce(jsonb_array_length(r.match->'${dimension}'),0)=0 OR r.match->'${dimension}' ? ${parameter})`;

const MATCHING_TEAM = `SELECT r.team_id FROM routing_rules r
  JOIN teams tm ON tm.org_id=r.org_id AND tm.id=r.team_id AND tm.archived_at IS NULL
  WHERE r.org_id=$1 AND ${dimensionMatches('tag', '$2')} AND ${dimensionMatches('urgency', '$3')}
    AND ${dimensionMatches('complexity', '$4')}
  ORDER BY r.priority LIMIT 1`;

export async function routeTicket(tx: Sql, org: string, ticketId: string): Promise<boolean> {
    const ticket = await one<{ tag: string; urgency: string; complexity: string; team_id: string | null }>(
        tx,
        'SELECT tag,urgency,complexity,team_id FROM tickets WHERE org_id=$1 AND id=$2',
        [org, ticketId],
    );

    if (!ticket) {
        return false;
    }

    const match = await one<{ team_id: string }>(tx, MATCHING_TEAM, [
        org,
        ticket.tag,
        ticket.urgency,
        ticket.complexity,
    ]);

    const teamId = match?.team_id ?? ticket.team_id;
    const changed = teamId !== ticket.team_id;

    await tx.query(
        `UPDATE tickets SET team_id=$3,routed_at=now(),
       offered_to=CASE WHEN $4 THEN NULL ELSE offered_to END,
       offered_at=CASE WHEN $4 THEN NULL ELSE offered_at END,
       offer_due_at=CASE WHEN $4 THEN NULL ELSE offer_due_at END
     WHERE org_id=$1 AND id=$2`,
        [org, ticketId, teamId, changed],
    );

    return changed;
}

async function rulesVersion(db: Sql, org: string): Promise<number> {
    const row = await one<{ version: number }>(
        db,
        'SELECT coalesce(max(version),0)::int AS version FROM routing_rules WHERE org_id=$1',
        [org],
    );

    return row?.version ?? 0;
}

export async function listRules(db: Sql, org: string) {
    const { rows } = await db.query(
        `SELECT id,priority,team_id,jsonb_build_object('tag',coalesce(match->'tag','[]'),
         'urgency',coalesce(match->'urgency','[]'),'complexity',coalesce(match->'complexity','[]')) AS match
       FROM routing_rules WHERE org_id=$1 ORDER BY priority`,
        [org],
    );

    return { items: rows, version: await rulesVersion(db, org) };
}

async function assertKnownCodes(tx: Sql, org: string, body: RulesBody): Promise<void> {
    const { rows } = await tx.query<{ key: string }>(
        "SELECT dimension||':'||code AS key FROM dictionaries WHERE org_id=$1",
        [org],
    );

    const known = new Set(rows.map((row) => row.key));

    for (const rule of body.rules) {
        for (const dimension of DIMENSIONS) {
            for (const code of rule.match[dimension]) {
                ensure(known.has(`${dimension}:${code}`), 'invalid_dictionary', 422, `Неизвестное значение «${code}».`);
            }
        }
    }
}

export async function replaceRules(tx: Sql, org: string, change: { body: RulesBody; expectedVersion: number }) {
    const { body } = change;
    const version = await rulesVersion(tx, org);

    ensure(version === change.expectedVersion, 'version_conflict', 409, 'Правила изменились. Обновите страницу.');
    await assertKnownCodes(tx, org, body);

    const teams = new Set(
        (
            await tx.query<{ id: string }>('SELECT id FROM teams WHERE org_id=$1 AND archived_at IS NULL', [org])
        ).rows.map((row) => row.id),
    );

    ensure(
        body.rules.every((rule) => teams.has(rule.team_id)),
        'invalid_team',
        422,
        'Команда не найдена.',
    );

    await tx.query('DELETE FROM routing_rules WHERE org_id=$1', [org]);

    for (const [priority, rule] of body.rules.entries()) {
        await tx.query('INSERT INTO routing_rules(org_id,priority,match,team_id,version) VALUES($1,$2,$3,$4,$5)', [
            org,
            priority,
            JSON.stringify(rule.match),
            rule.team_id,
            version + 1,
        ]);
    }

    return listRules(tx, org);
}

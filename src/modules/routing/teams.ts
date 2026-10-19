import { z } from 'zod';

import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { emit } from '../../shared/events.js';

const skill = z.string().regex(/^(tag|complexity):[a-z][a-z0-9_]*$/);

const member = z.object({ employee_id: z.uuid(), skills: z.array(skill).max(100).default([]) }).strict();

export const teamBody = z
    .object({
        name: z.string().trim().min(1).max(80),
        supervisor_id: z.uuid().nullable().default(null),
        auto_assign: z.boolean().default(false),
        strategy: z.enum(['round_robin', 'least_loaded', 'skills']).default('least_loaded'),
        capacity: z.number().int().min(1).max(100).default(5),
        offer_timeout_seconds: z.number().int().min(30).max(3600).default(180),
        allow_self_take: z.boolean().default(true),
        members: z.array(member).max(500).default([]),
    })
    .strict();

export type TeamBody = z.infer<typeof teamBody>;

const TEAM_COLUMNS = `t.id,t.name,t.supervisor_id,t.auto_assign,t.strategy,t.capacity,t.offer_timeout_seconds,
  t.allow_self_take,t.version,
  coalesce((SELECT jsonb_agg(jsonb_build_object('employee_id',m.employee_id,'skills',m.skills) ORDER BY e.name)
    FROM team_members m JOIN employees e ON e.id=m.employee_id WHERE m.team_id=t.id),'[]'::jsonb) AS members,
  (SELECT count(*)::int FROM tickets x WHERE x.org_id=t.org_id AND x.team_id=t.id AND x.status='open') AS queue,
  (SELECT count(*)::int FROM team_members m JOIN employees e ON e.id=m.employee_id
    WHERE m.team_id=t.id AND e.presence='online' AND NOT e.blocked) AS online`;

export async function listTeams(db: Sql, org: string) {
    const { rows } = await db.query(
        `SELECT ${TEAM_COLUMNS} FROM teams t WHERE t.org_id=$1 AND t.archived_at IS NULL ORDER BY lower(t.name)`,
        [org],
    );

    return { items: rows };
}

async function findTeam(db: Sql, org: string, id: string) {
    return one(db, `SELECT ${TEAM_COLUMNS} FROM teams t WHERE t.org_id=$1 AND t.id=$2`, [org, id]);
}

async function assertMembers(tx: Sql, org: string, body: TeamBody): Promise<void> {
    const ids = [...new Set(body.members.map((entry) => entry.employee_id))];

    ensure(ids.length === body.members.length, 'duplicate_member', 422, 'Сотрудник указан дважды.');

    const { rows } = await tx.query<{ id: string; role: string }>(
        'SELECT id,role FROM employees WHERE org_id=$1 AND id=ANY($2::uuid[]) AND NOT blocked',
        [org, [...ids, ...(body.supervisor_id ? [body.supervisor_id] : [])]],
    );

    const found = new Map(rows.map((row) => [row.id, row.role]));

    ensure(
        ids.every((id) => found.has(id)),
        'invalid_employee',
        422,
        'Сотрудник не найден или заблокирован.',
    );

    if (body.supervisor_id) {
        ensure(
            ['supervisor', 'admin'].includes(found.get(body.supervisor_id) ?? ''),
            'invalid_supervisor',
            422,
            'Руководителем команды может быть только руководитель или администратор.',
        );
    }
}

async function assertNameFree(tx: Sql, org: string, name: string, except: string | null): Promise<void> {
    const taken = await one(
        tx,
        `SELECT id FROM teams WHERE org_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL
       AND id IS DISTINCT FROM $3`,
        [org, name, except],
    );

    ensure(!taken, 'team_name_taken', 409, 'Команда с таким названием уже есть.');
}

async function replaceMembers(tx: Sql, org: string, teamId: string, body: TeamBody): Promise<void> {
    await tx.query('DELETE FROM team_members WHERE team_id=$1', [teamId]);

    for (const entry of body.members) {
        await tx.query('INSERT INTO team_members(org_id,team_id,employee_id,skills) VALUES($1,$2,$3,$4)', [
            org,
            teamId,
            entry.employee_id,
            entry.skills,
        ]);
    }
}

export async function createTeam(tx: Sql, org: string, body: TeamBody) {
    await assertMembers(tx, org, body);
    await assertNameFree(tx, org, body.name, null);

    const created = await one<{ id: string }>(
        tx,
        `INSERT INTO teams(org_id,name,supervisor_id,auto_assign,strategy,capacity,offer_timeout_seconds,allow_self_take)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
            org,
            body.name,
            body.supervisor_id,
            body.auto_assign,
            body.strategy,
            body.capacity,
            body.offer_timeout_seconds,
            body.allow_self_take,
        ],
    );

    ensure(created, 'team_not_created');
    await replaceMembers(tx, org, created.id, body);

    return findTeam(tx, org, created.id);
}

async function lockTeam(tx: Sql, org: string, id: string, expectedVersion: number): Promise<void> {
    const team = await one<{ version: number }>(
        tx,
        'SELECT version FROM teams WHERE org_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE',
        [org, id],
    );

    ensure(team, 'not_found', 404);
    ensure(team.version === expectedVersion, 'version_conflict', 409, 'Команда изменилась. Обновите страницу.');
}

export async function updateTeam(
    tx: Sql,
    org: string,
    change: { id: string; body: TeamBody; expectedVersion: number },
) {
    const { id, body } = change;

    await lockTeam(tx, org, id, change.expectedVersion);
    await assertMembers(tx, org, body);
    await assertNameFree(tx, org, body.name, id);

    await tx.query(
        `UPDATE teams SET name=$3,supervisor_id=$4,auto_assign=$5,strategy=$6,capacity=$7,offer_timeout_seconds=$8,
       allow_self_take=$9,version=version+1 WHERE org_id=$1 AND id=$2`,
        [
            org,
            id,
            body.name,
            body.supervisor_id,
            body.auto_assign,
            body.strategy,
            body.capacity,
            body.offer_timeout_seconds,
            body.allow_self_take,
        ],
    );

    await replaceMembers(tx, org, id, body);

    return findTeam(tx, org, id);
}

export async function archiveTeam(tx: Sql, org: string, change: { id: string; expectedVersion: number }) {
    await lockTeam(tx, org, change.id, change.expectedVersion);
    await tx.query('UPDATE teams SET archived_at=now(),version=version+1 WHERE id=$1', [change.id]);
    await tx.query('DELETE FROM routing_rules WHERE team_id=$1', [change.id]);
    await tx.query('DELETE FROM team_members WHERE team_id=$1', [change.id]);

    const { rows } = await tx.query<{ id: string }>(
        `UPDATE tickets SET team_id=NULL,offered_to=NULL,offered_at=NULL,offer_due_at=NULL,version=version+1,updated_at=now()
     WHERE org_id=$1 AND team_id=$2 AND status IN('open','in_progress') RETURNING id`,
        [org, change.id],
    );

    for (const ticket of rows) {
        await emit(tx, org, { type: 'ticket.updated', ticketId: ticket.id });
    }

    return { id: change.id, archived: true };
}

import { z } from 'zod';

import { requireOne, one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

import { reclassifySla } from './clocks.js';
import { loadSlaSettings, minuteOfDay } from './sla-settings.js';

const BACKFILL_LIMIT = 2000;
const HOURS_MESSAGE = 'Проверьте рабочие часы: начало раньше конца, интервалы не пересекаются.';
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/);
const day = z.array(z.tuple([time, time])).max(4);
const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const minutes = z.number().int().min(1).max(43200);

const policy = z
    .object({
        urgency: code,
        tag: z.union([code, z.literal('*')]),
        first_response_minutes: minutes,
        resolution_minutes: minutes,
    })
    .strict();

export const slaConfigBody = z
    .object({
        enabled: z.boolean(),
        week: z.object({ 1: day, 2: day, 3: day, 4: day, 5: day, 6: day, 7: day }).strict(),
        holidays: z.array(z.iso.date()).max(400),
        workdays: z.array(z.iso.date()).max(100),
        notify_max: z.boolean(),
        client_eta: z.boolean(),
        waiting_reminder_hours: z.number().int().min(0).max(720),
        waiting_close_hours: z.number().int().min(0).max(2160),
        policies: z.array(policy).max(500),
    })
    .strict();

export type SlaConfigBody = z.infer<typeof slaConfigBody>;

export async function readSlaConfig(db: Sql, org: string) {
    const settings = await loadSlaSettings(db, org);

    ensure(settings, 'not_found', 404);

    const policies = await db.query(
        `SELECT urgency,tag,first_response_minutes,resolution_minutes FROM sla_policies
     WHERE org_id=$1 ORDER BY urgency,tag`,
        [org],
    );

    return { ...settings, policies: policies.rows };
}

function assertValidWeek(week: SlaConfigBody['week']): void {
    let working = 0;

    for (const intervals of Object.values(week)) {
        let previousEnd = -1;

        for (const [from, to] of intervals) {
            ensure(minuteOfDay(from) < minuteOfDay(to), 'invalid_work_hours', 422, HOURS_MESSAGE);
            ensure(minuteOfDay(from) >= previousEnd, 'invalid_work_hours', 422, HOURS_MESSAGE);
            previousEnd = minuteOfDay(to);
            working++;
        }
    }

    ensure(working > 0, 'invalid_work_hours', 422, 'Укажите хотя бы один рабочий интервал.');
}

async function assertValidPolicies(tx: Sql, org: string, policies: SlaConfigBody['policies']): Promise<void> {
    const keys = new Set(policies.map((entry) => `${entry.urgency}:${entry.tag}`));

    ensure(keys.size === policies.length, 'duplicate_policy', 422, 'Для срочности и темы задайте один срок.');

    for (const entry of policies) {
        ensure(
            entry.resolution_minutes >= entry.first_response_minutes,
            'invalid_policy',
            422,
            'Срок решения не может быть меньше срока первого ответа.',
        );

        const known = await one(
            tx,
            `SELECT 1 AS ok FROM dictionaries WHERE org_id=$1 AND dimension='urgency' AND code=$2
       AND ($3='*' OR EXISTS(SELECT 1 FROM dictionaries WHERE org_id=$1 AND dimension='tag' AND code=$3))`,
            [org, entry.urgency, entry.tag],
        );

        ensure(known, 'invalid_dictionary', 422, 'В сроках указана неизвестная срочность или тема.');
    }
}

export function assertValidConfig(body: SlaConfigBody): void {
    assertValidWeek(body.week);

    const { waiting_reminder_hours: remind, waiting_close_hours: close } = body;

    ensure(
        !remind || !close || close > remind,
        'invalid_waiting_timers',
        422,
        'Автозакрытие должно наступать позже напоминания.',
    );
}

export async function saveSlaConfig(
    tx: Sql,
    org: string,
    { body, expectedVersion }: { body: SlaConfigBody; expectedVersion: number },
) {
    await assertValidPolicies(tx, org, body.policies);

    const before = await requireOne<{ enabled: boolean }>(tx, 'SELECT enabled FROM sla_settings WHERE org_id=$1', [
        org,
    ]);

    const saved = await one(
        tx,
        `UPDATE sla_settings SET enabled=$3,week=$4,holidays=$5::date[],workdays=$6::date[],notify_max=$7,
       client_eta=$8,waiting_reminder_hours=$9,waiting_close_hours=$10,version=version+1
     WHERE org_id=$1 AND version=$2 RETURNING version`,
        [
            org,
            expectedVersion,
            body.enabled,
            JSON.stringify(body.week),
            [...new Set(body.holidays)].sort(),
            [...new Set(body.workdays)].sort(),
            body.notify_max,
            body.client_eta,
            body.waiting_reminder_hours,
            body.waiting_close_hours,
        ],
    );

    ensure(saved, 'version_conflict');
    await tx.query('DELETE FROM sla_policies WHERE org_id=$1', [org]);

    for (const entry of body.policies) {
        await tx.query(
            `INSERT INTO sla_policies(org_id,urgency,tag,first_response_minutes,resolution_minutes)
       VALUES($1,$2,$3,$4,$5)`,
            [org, entry.urgency, entry.tag, entry.first_response_minutes, entry.resolution_minutes],
        );
    }

    await applyToOpenTickets(tx, org, { wasEnabled: before.enabled, enabled: body.enabled });

    return readSlaConfig(tx, org);
}

async function applyToOpenTickets(
    tx: Sql,
    org: string,
    { wasEnabled, enabled }: { wasEnabled: boolean; enabled: boolean },
): Promise<void> {
    if (!enabled) {
        if (wasEnabled) {
            await tx.query(
                `UPDATE tickets SET sla_first_response_minutes=NULL,sla_resolution_minutes=NULL,
           first_response_warn_at=NULL,first_response_due_at=NULL,resolution_warn_at=NULL,resolution_due_at=NULL,
           sla_next_check_at=NULL,version=version+1
         WHERE org_id=$1 AND status IN('open','in_progress')`,
                [org],
            );
        }

        return;
    }

    const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM tickets WHERE org_id=$1 AND status IN('open','in_progress')
       AND sla_first_response_minutes IS NULL AND sla_resolution_minutes IS NULL
     ORDER BY created_at LIMIT ${BACKFILL_LIMIT} FOR UPDATE`,
        [org],
    );

    for (const ticket of rows) {
        await reclassifySla(tx, org, ticket.id);
    }
}

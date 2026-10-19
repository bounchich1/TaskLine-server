import { one, type Sql } from '../../shared/db.js';

import type { Calendar, WorkInterval } from './business-time.js';

type WeekSchedule = Record<string, [string, string][]>;

export type SlaSettings = {
    enabled: boolean;
    timezone: string;
    week: WeekSchedule;
    holidays: string[];
    workdays: string[];
    notify_max: boolean;
    client_eta: boolean;
    waiting_reminder_hours: number;
    waiting_close_hours: number;
    version: number;
};

export type SlaTargets = {
    first_response_minutes: number;
    resolution_minutes: number;
};

const DEFAULT_POLICIES: [string, number, number][] = [
    ['critical', 15, 240],
    ['high', 30, 480],
    ['medium', 60, 960],
    ['low', 240, 2400],
];

export async function ensureSlaDefaults(tx: Sql, org: string): Promise<void> {
    const created = await one(
        tx,
        'INSERT INTO sla_settings(org_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING org_id',
        [org],
    );

    if (!created) {
        return;
    }

    for (const [urgency, firstResponse, resolution] of DEFAULT_POLICIES) {
        await tx.query(
            `INSERT INTO sla_policies(org_id,urgency,first_response_minutes,resolution_minutes)
       VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [org, urgency, firstResponse, resolution],
        );
    }
}

export async function loadSlaSettings(db: Sql, org: string): Promise<SlaSettings | undefined> {
    return one<SlaSettings>(
        db,
        `SELECT s.enabled,o.timezone,s.week,s.holidays::text[] AS holidays,s.workdays::text[] AS workdays,
       s.notify_max,s.client_eta,s.waiting_reminder_hours,s.waiting_close_hours,s.version
     FROM sla_settings s JOIN organizations o ON o.id=s.org_id WHERE s.org_id=$1`,
        [org],
    );
}

export async function findTargets(
    db: Sql,
    org: string,
    { urgency, tag }: { urgency: string; tag: string },
): Promise<SlaTargets | undefined> {
    return one<SlaTargets>(
        db,
        `SELECT first_response_minutes,resolution_minutes FROM sla_policies
     WHERE org_id=$1 AND urgency=$2 AND tag IN($3,'*') ORDER BY tag='*' LIMIT 1`,
        [org, urgency, tag],
    );
}

export function minuteOfDay(time: string): number {
    const [hours, minutes] = time.split(':');

    return Number(hours) * 60 + Number(minutes);
}

export function calendarOf(settings: Pick<SlaSettings, 'timezone' | 'week' | 'holidays' | 'workdays'>): Calendar {
    const week = new Map<number, WorkInterval[]>();

    for (let weekday = 1; weekday <= 7; weekday++) {
        const intervals = settings.week[String(weekday)] ?? [];

        week.set(
            weekday,
            intervals.map(([from, to]) => [minuteOfDay(from), minuteOfDay(to)]),
        );
    }

    return {
        timezone: settings.timezone,
        week,
        holidays: new Set(settings.holidays),
        workdays: new Set(settings.workdays),
    };
}

export async function loadBusinessCalendar(db: Sql, org: string): Promise<Calendar | undefined> {
    const settings = await loadSlaSettings(db, org);

    return settings?.enabled ? calendarOf(settings) : undefined;
}

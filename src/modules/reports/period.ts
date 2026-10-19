import { z } from 'zod';

import { requireOne, type Sql } from '../../shared/db.js';

const MAX_DAYS = 366;
const DAY_MS = 86400000;

export const periodQuery = z
    .object({ from: z.iso.date(), to: z.iso.date() })
    .strict()
    .refine(({ from, to }) => from <= to, { message: 'from must not be after to' })
    .refine(({ from, to }) => (Date.parse(to) - Date.parse(from)) / DAY_MS < MAX_DAYS, { message: 'period too long' });

export type PeriodInput = z.infer<typeof periodQuery>;

export interface Period {
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    timezone: string;
    start: Date;
    end: Date;
    previousStart: Date;
}

interface PeriodRow extends Record<string, unknown> {
    timezone: string;
    start: Date | string;
    end: Date | string;
    previous_start: Date | string;
    previous_from: string;
    previous_to: string;
}

export async function resolvePeriod(db: Sql, org: string, { from, to }: PeriodInput): Promise<Period> {
    const row = await requireOne<PeriodRow>(
        db,
        `SELECT o.timezone,
       ($2::date)::timestamp AT TIME ZONE o.timezone AS start,
       ($3::date+1)::timestamp AT TIME ZONE o.timezone AS "end",
       ($2::date-($3::date-$2::date+1))::timestamp AT TIME ZONE o.timezone AS previous_start,
       to_char($2::date-($3::date-$2::date+1),'YYYY-MM-DD') AS previous_from,
       to_char($2::date-1,'YYYY-MM-DD') AS previous_to
     FROM organizations o WHERE o.id=$1`,
        [org, from, to],
    );

    return {
        from,
        to,
        previousFrom: row.previous_from,
        previousTo: row.previous_to,
        timezone: row.timezone,
        start: new Date(row.start),
        end: new Date(row.end),
        previousStart: new Date(row.previous_start),
    };
}

export function periodBody(period: Period) {
    return {
        from: period.from,
        to: period.to,
        previous_from: period.previousFrom,
        previous_to: period.previousTo,
        timezone: period.timezone,
    };
}

export function seconds(column: string): string {
    return `extract(epoch FROM ${column})`;
}

export function median(expression: string, filter: string): string {
    return `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${expression}) FILTER (WHERE ${filter})`;
}

export function percentile(share: number, expression: string, filter: string): string {
    return `percentile_cont(${share}) WITHIN GROUP (ORDER BY ${expression}) FILTER (WHERE ${filter})`;
}

export function within(column: string, from = '$2', to = '$3'): string {
    return `${column}>=${from} AND ${column}<${to}`;
}

export function numberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) {
        return null;
    }

    const number = Number(value);

    return Number.isFinite(number) ? number : null;
}

export function share(part: unknown, total: unknown): number | null {
    const whole = Number(total);

    return whole > 0 ? Number(part) / whole : null;
}

import type { Sql } from '../../shared/db.js';
import type { Row } from '../../shared/types/entities.js';

import { median, numberOrNull, seconds, within, type Period } from './period.js';
import { MIN_SAMPLE } from './team.js';

const GROWTH_MIN_VOLUME = 3;
const GROWING_LIMIT = 5;

const CLOSED = within('f.closed_at');

const TOPICS = `SELECT d.code,d.label,d.active,
  count(f.ticket_id) FILTER (WHERE f.lifecycle=1 AND ${within('f.started_at')})::int AS created,
  count(f.ticket_id) FILTER (WHERE f.lifecycle=1 AND ${within('f.started_at', '$4', '$2')})::int AS previous,
  count(f.ticket_id) FILTER (WHERE ${CLOSED})::int AS closed,
  ${median(seconds('f.closed_at-f.started_at'), CLOSED)} AS resolution_p50,
  ${median('f.resolution_business_seconds', CLOSED)} AS resolution_business_p50,
  avg(f.rating) FILTER (WHERE ${CLOSED}) AS csat,
  count(f.rating) FILTER (WHERE ${CLOSED})::int AS rated
FROM dictionaries d
LEFT JOIN ticket_facts f ON f.org_id=d.org_id AND f.tag=d.code AND f.started_at<$3
  AND (f.closed_at IS NULL OR f.closed_at>=$4)
WHERE d.org_id=$1 AND d.dimension='tag'
GROUP BY d.code,d.label,d.active,d.rank ORDER BY d.rank,d.label`;

const DAILY = `SELECT tag,to_char((started_at AT TIME ZONE $4)::date,'YYYY-MM-DD') AS day,count(*)::int AS created
FROM ticket_facts WHERE org_id=$1 AND lifecycle=1 AND ${within('started_at')} GROUP BY 1,2`;

function days(period: Period): string[] {
    const result: string[] = [];
    const cursor = new Date(`${period.from}T00:00:00Z`);

    while (cursor.toISOString().slice(0, 10) <= period.to) {
        result.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return result;
}

function growth(created: number, previous: number): number | null {
    if (previous === 0) {
        return created > 0 ? null : 0;
    }

    return (created - previous) / previous;
}

function topicRow(row: Row, businessHours: boolean, series: number[]) {
    const created = Number(row.created);
    const previous = Number(row.previous);
    const closed = Number(row.closed);
    const rated = Number(row.rated);

    return {
        code: String(row.code),
        label: String(row.label),
        active: Boolean(row.active),
        created,
        previous,
        growth: growth(created, previous),
        closed,
        resolution_p50:
            closed >= MIN_SAMPLE
                ? numberOrNull(businessHours ? row.resolution_business_p50 : row.resolution_p50)
                : null,
        csat: rated >= MIN_SAMPLE ? numberOrNull(row.csat) : null,
        rated,
        series,
    };
}

export type TopicRow = ReturnType<typeof topicRow>;

function fastestGrowing(items: TopicRow[]): string[] {
    return items
        .filter((item) => item.created >= GROWTH_MIN_VOLUME && item.created > item.previous)
        .sort(
            (left, right) =>
                (right.created - right.previous) / Math.max(1, right.previous) -
                (left.created - left.previous) / Math.max(1, left.previous),
        )
        .slice(0, GROWING_LIMIT)
        .map((item) => item.code);
}

export async function topicsReport(db: Sql, org: string, period: Period, businessHours: boolean) {
    const { rows } = await db.query(TOPICS, [org, period.start, period.end, period.previousStart]);
    const { rows: daily } = await db.query(DAILY, [org, period.start, period.end, period.timezone]);
    const dayList = days(period);
    const index = new Map(dayList.map((day, position) => [day, position]));
    const series = new Map<string, number[]>();

    for (const point of daily) {
        const values = series.get(String(point.tag)) ?? dayList.map(() => 0);
        const position = index.get(String(point.day));

        if (position !== undefined) {
            values[position] = Number(point.created);
        }

        series.set(String(point.tag), values);
    }

    const items = rows
        .map((row) => topicRow(row, businessHours, series.get(String(row.code)) ?? dayList.map(() => 0)))
        .filter((item) => item.active || item.created > 0 || item.previous > 0 || item.closed > 0);

    return { business_hours: businessHours, days: dayList, items, fastest_growing: fastestGrowing(items) };
}

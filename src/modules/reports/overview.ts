import { requireOne, type Sql } from '../../shared/db.js';
import type { Row } from '../../shared/types/entities.js';

import { median, numberOrNull, percentile, seconds, share, within, type Period } from './period.js';

const CLOSED = within('closed_at');
const RESPONDED = within('first_response_at');
const RESPONSE = seconds('first_response_at-started_at');
const RESOLUTION = seconds('closed_at-started_at');

const WINDOW_METRICS = `SELECT
  count(*) FILTER (WHERE lifecycle=1 AND ${within('started_at')})::int AS created,
  count(*) FILTER (WHERE ${CLOSED})::int AS closed,
  count(*) FILTER (WHERE started_at<$3 AND (closed_at IS NULL OR closed_at>=$3))::int AS open_end,
  ${median(RESPONSE, RESPONDED)} AS response_p50,
  ${percentile(0.9, RESPONSE, RESPONDED)} AS response_p90,
  ${median('first_response_business_seconds', RESPONDED)} AS response_business_p50,
  ${percentile(0.9, 'first_response_business_seconds', RESPONDED)} AS response_business_p90,
  ${median(RESOLUTION, CLOSED)} AS resolution_p50,
  ${percentile(0.9, RESOLUTION, CLOSED)} AS resolution_p90,
  ${median('resolution_business_seconds', CLOSED)} AS resolution_business_p50,
  ${percentile(0.9, 'resolution_business_seconds', CLOSED)} AS resolution_business_p90,
  ${median(seconds('assigned_at-started_at'), `lifecycle=1 AND ${within('assigned_at')}`)} AS assignment_p50,
  avg(rating) FILTER (WHERE ${CLOSED}) AS csat,
  count(rating) FILTER (WHERE ${CLOSED})::int AS rated,
  count(*) FILTER (WHERE ${CLOSED} AND rating>=9)::int AS promoters,
  count(*) FILTER (WHERE ${CLOSED} AND rating<=6)::int AS detractors,
  count(*) FILTER (WHERE ${CLOSED} AND rating_requested)::int AS rating_requested,
  count(*) FILTER (WHERE ${CLOSED} AND rating_requested AND rating IS NOT NULL)::int AS rated_requested,
  count(*) FILTER (WHERE ${CLOSED} AND reopened_at<=closed_at+interval '7 days')::int AS reopened,
  count(sla_response_met) FILTER (WHERE ${RESPONDED})::int AS sla_response_total,
  count(*) FILTER (WHERE ${RESPONDED} AND sla_response_met)::int AS sla_response_met,
  count(sla_resolution_met) FILTER (WHERE ${CLOSED})::int AS sla_resolution_total,
  count(*) FILTER (WHERE ${CLOSED} AND sla_resolution_met)::int AS sla_resolution_met
FROM ticket_facts WHERE org_id=$1 AND started_at<$3 AND (closed_at IS NULL OR closed_at>=$2)`;

const DAILY_TREND = `SELECT to_char(d,'YYYY-MM-DD') AS day,
  count(f.ticket_id) FILTER (WHERE f.lifecycle=1 AND f.started_at>=b.ds AND f.started_at<b.de)::int AS created,
  count(f.ticket_id) FILTER (WHERE f.closed_at>=b.ds AND f.closed_at<b.de)::int AS closed,
  count(f.ticket_id) FILTER (WHERE f.started_at<b.de AND (f.closed_at IS NULL OR f.closed_at>=b.de))::int AS open_end
FROM generate_series($2::date,$3::date,interval '1 day') d
CROSS JOIN LATERAL (SELECT d::timestamp AT TIME ZONE $4 AS ds,(d+interval '1 day')::timestamp AT TIME ZONE $4 AS de) b
LEFT JOIN ticket_facts f ON f.org_id=$1 AND f.started_at<b.de AND (f.closed_at IS NULL OR f.closed_at>=b.ds)
GROUP BY d ORDER BY d`;

function metrics(row: Row, businessHours: boolean) {
    const timing = (name: string) => numberOrNull(row[businessHours ? name.replace('_p', '_business_p') : name]);

    return {
        created: Number(row.created),
        closed: Number(row.closed),
        open_end: Number(row.open_end),
        response_p50: timing('response_p50'),
        response_p90: timing('response_p90'),
        resolution_p50: timing('resolution_p50'),
        resolution_p90: timing('resolution_p90'),
        assignment_p50: numberOrNull(row.assignment_p50),
        csat: numberOrNull(row.csat),
        rated: Number(row.rated),
        promoters: share(row.promoters, row.rated),
        detractors: share(row.detractors, row.rated),
        rating_response: share(row.rated_requested, row.rating_requested),
        reopen_rate: share(row.reopened, row.closed),
        sla_response: share(row.sla_response_met, row.sla_response_total),
        sla_resolution: share(row.sla_resolution_met, row.sla_resolution_total),
    };
}

export type OverviewMetrics = ReturnType<typeof metrics>;

export async function windowMetrics(db: Sql, org: string, window: { start: Date; end: Date; businessHours: boolean }) {
    return metrics(await requireOne(db, WINDOW_METRICS, [org, window.start, window.end]), window.businessHours);
}

export async function overviewReport(db: Sql, org: string, period: Period, businessHours: boolean) {
    const current = await windowMetrics(db, org, { start: period.start, end: period.end, businessHours });

    const previous = await windowMetrics(db, org, {
        start: period.previousStart,
        end: period.start,
        businessHours,
    });

    const { rows: trend } = await db.query(DAILY_TREND, [org, period.from, period.to, period.timezone]);

    return { business_hours: businessHours, current, previous, trend };
}

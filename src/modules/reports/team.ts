import type { Sql } from '../../shared/db.js';
import type { Row } from '../../shared/types/entities.js';

import { median, numberOrNull, seconds, share, within, type Period } from './period.js';

export const MIN_SAMPLE = 5;

const CLOSED = within('closed_at');
const RESPONDED = within('first_response_at');

const TEAM_REPORT = `WITH f AS (
  SELECT * FROM ticket_facts WHERE org_id=$1 AND assignee_id IS NOT NULL AND started_at<$3
    AND (closed_at IS NULL OR closed_at>=$2)
), stats AS (
  SELECT assignee_id AS employee_id,
    count(*) FILTER (WHERE ${within('assigned_at')})::int AS taken,
    count(*) FILTER (WHERE ${CLOSED})::int AS closed,
    count(*) FILTER (WHERE ${RESPONDED})::int AS responded,
    ${median(seconds('first_response_at-started_at'), RESPONDED)} AS response_p50,
    ${median('first_response_business_seconds', RESPONDED)} AS response_business_p50,
    ${median(seconds('closed_at-started_at'), CLOSED)} AS resolution_p50,
    ${median('resolution_business_seconds', CLOSED)} AS resolution_business_p50,
    avg(rating) FILTER (WHERE ${CLOSED}) AS csat,
    count(rating) FILTER (WHERE ${CLOSED})::int AS rated,
    count(*) FILTER (WHERE ${CLOSED} AND reopened_at<=closed_at+interval '7 days')::int AS reopened,
    coalesce(sum(staff_replies) FILTER (WHERE ${CLOSED}),0)::int AS replies,
    coalesce(sum(ai_draft_replies) FILTER (WHERE ${CLOSED}),0)::int AS ai_replies,
    coalesce(sum(macro_replies) FILTER (WHERE ${CLOSED}),0)::int AS macro_replies
  FROM f GROUP BY assignee_id
), transfers AS (
  SELECT (detail->>'from')::uuid AS employee_id,count(*)::int AS transfers_out FROM ticket_events
  WHERE org_id=$1 AND kind='transferred' AND detail ? 'from' AND ${within('created_at')} GROUP BY 1
), active AS (
  SELECT assignee_id AS employee_id,count(*)::int AS active FROM tickets
  WHERE org_id=$1 AND status='in_progress' GROUP BY 1
), presence AS (
  SELECT employee_id,presence,started_at,
    coalesce(lead(started_at) OVER (PARTITION BY employee_id ORDER BY started_at,id),now()) AS ended_at
  FROM presence_log WHERE org_id=$1 AND started_at<$3
), online AS (
  SELECT employee_id,sum(greatest(0,extract(epoch FROM least(ended_at,$3)-greatest(started_at,$2))))::int AS seconds
  FROM presence WHERE presence='online' AND ended_at>$2 GROUP BY employee_id
)
SELECT e.id,e.name,e.role,e.presence,e.blocked,s.*,coalesce(t.transfers_out,0) AS transfers_out,
  coalesce(a.active,0) AS active,coalesce(o.seconds,0) AS online_seconds,
  coalesce((SELECT max(tm.capacity) FROM team_members m JOIN teams tm ON tm.id=m.team_id AND tm.archived_at IS NULL
    WHERE m.employee_id=e.id),5) AS capacity
FROM employees e LEFT JOIN stats s ON s.employee_id=e.id LEFT JOIN transfers t ON t.employee_id=e.id
LEFT JOIN active a ON a.employee_id=e.id LEFT JOIN online o ON o.employee_id=e.id
WHERE e.org_id=$1 AND e.activated_at IS NOT NULL
  AND (NOT e.blocked OR s.employee_id IS NOT NULL OR t.employee_id IS NOT NULL)
ORDER BY coalesce(a.active,0)+coalesce(s.closed,0) DESC,e.name`;

function sampled(value: unknown, count: number): number | null {
    return count >= MIN_SAMPLE ? numberOrNull(value) : null;
}

function teamRow(row: Row, businessHours: boolean) {
    const responded = Number(row.responded ?? 0);
    const closed = Number(row.closed ?? 0);
    const rated = Number(row.rated ?? 0);

    return {
        employee_id: String(row.id),
        name: String(row.name),
        role: String(row.role),
        presence: String(row.presence),
        blocked: Boolean(row.blocked),
        taken: Number(row.taken ?? 0),
        closed,
        active: Number(row.active),
        capacity: Number(row.capacity),
        responded,
        response_p50: sampled(businessHours ? row.response_business_p50 : row.response_p50, responded),
        resolution_p50: sampled(businessHours ? row.resolution_business_p50 : row.resolution_p50, closed),
        csat: sampled(row.csat, rated),
        rated,
        reopen_rate: closed >= MIN_SAMPLE ? share(row.reopened, closed) : null,
        transfers_out: Number(row.transfers_out),
        online_seconds: Number(row.online_seconds),
        ai_draft_share: share(row.ai_replies, row.replies),
        macro_share: share(row.macro_replies, row.replies),
    };
}

export type TeamRow = ReturnType<typeof teamRow>;

export async function teamReport(db: Sql, org: string, period: Period, businessHours: boolean) {
    const { rows } = await db.query(TEAM_REPORT, [org, period.start, period.end]);

    return {
        business_hours: businessHours,
        min_sample: MIN_SAMPLE,
        items: rows.map((row) => teamRow(row, businessHours)),
    };
}

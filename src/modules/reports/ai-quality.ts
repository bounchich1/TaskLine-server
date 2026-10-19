import { requireOne, type Sql } from '../../shared/db.js';
import type { Row } from '../../shared/types/entities.js';

import { median, numberOrNull, seconds, share, within, type Period } from './period.js';

const CLOSED = within('closed_at');
const STARTED = within('started_at');
const AI_CLOSED = `lifecycle=1 AND ai_classified AND ${CLOSED}`;
const TIPPED = `${AI_CLOSED} AND tip_shown`;

const QUALITY = `SELECT
  count(*) FILTER (WHERE ${AI_CLOSED})::int AS classified,
  count(*) FILTER (WHERE ${AI_CLOSED} AND ai_tag_kept)::int AS tag_kept,
  count(*) FILTER (WHERE ${AI_CLOSED} AND ai_urgency_kept)::int AS urgency_kept,
  count(*) FILTER (WHERE ${AI_CLOSED} AND ai_complexity_kept)::int AS complexity_kept,
  count(*) FILTER (WHERE ${AI_CLOSED} AND ai_tag_kept AND ai_urgency_kept AND ai_complexity_kept)::int AS all_kept,
  count(*) FILTER (WHERE lifecycle=1 AND ai_classified AND ${STARTED})::int AS triaged,
  count(*) FILTER (WHERE lifecycle=1 AND ai_classified AND ${STARTED} AND review_required)::int AS needs_review,
  count(*) FILTER (WHERE ${TIPPED})::int AS tipped,
  count(*) FILTER (WHERE ${TIPPED} AND sources_cited>0)::int AS grounded,
  ${median(seconds('closed_at-started_at'), `${TIPPED} AND sources_cited>0`)} AS grounded_resolution_p50,
  ${median(seconds('closed_at-started_at'), `${TIPPED} AND sources_cited=0`)} AS ungrounded_resolution_p50,
  avg(recall_hits) FILTER (WHERE lifecycle=1 AND ai_classified AND ${STARTED}) AS recall_hits,
  count(*) FILTER (WHERE ${CLOSED})::int AS closed,
  count(*) FILTER (WHERE ${CLOSED} AND draft_used)::int AS draft_tickets,
  coalesce(sum(staff_replies) FILTER (WHERE ${CLOSED}),0)::int AS replies,
  coalesce(sum(ai_draft_replies) FILTER (WHERE ${CLOSED}),0)::int AS ai_replies,
  coalesce(sum(macro_replies) FILTER (WHERE ${CLOSED}),0)::int AS macro_replies,
  ${median('draft_edit_ratio', `${CLOSED} AND draft_edit_ratio IS NOT NULL`)} AS draft_edit_p50
FROM ticket_facts WHERE org_id=$1 AND started_at<$3 AND (closed_at IS NULL OR closed_at>=$2)`;

const ENGAGEMENT = `SELECT
  count(*) FILTER (WHERE kind='tip_viewed')::int AS tip_views,
  count(DISTINCT ticket_id) FILTER (WHERE kind='tip_viewed')::int AS tip_viewed_tickets,
  count(*) FILTER (WHERE kind='draft_inserted')::int AS drafts_inserted,
  count(*) FILTER (WHERE kind='source_opened')::int AS sources_opened
FROM ticket_events WHERE org_id=$1 AND ${within('created_at')}
  AND kind IN('tip_viewed','draft_inserted','source_opened')`;

const KNOWLEDGE = `SELECT
  (SELECT count(*)::int FROM memory_records WHERE org_id=$1 AND eligible AND state<>'deleted') AS eligible_records,
  (SELECT count(*)::int FROM closures WHERE org_id=$1 AND learning_status='learned' AND ${within('closed_at')}) AS learned`;

const LEARNED_WEEKLY = `SELECT to_char(date_trunc('week',(closed_at AT TIME ZONE $4)),'YYYY-MM-DD') AS week,count(*)::int AS learned
FROM closures WHERE org_id=$1 AND learning_status='learned' AND ${within('closed_at')} GROUP BY 1 ORDER BY 1`;

function accuracy(row: Row) {
    return {
        classified: Number(row.classified),
        tag: share(row.tag_kept, row.classified),
        urgency: share(row.urgency_kept, row.classified),
        complexity: share(row.complexity_kept, row.classified),
        all: share(row.all_kept, row.classified),
    };
}

function drafts(row: Row) {
    return {
        replies: Number(row.replies),
        ai_share: share(row.ai_replies, row.replies),
        macro_share: share(row.macro_replies, row.replies),
        ticket_share: share(row.draft_tickets, row.closed),
        edit_p50: numberOrNull(row.draft_edit_p50),
    };
}

export async function aiQuality(db: Sql, org: string, period: Period) {
    const params = [org, period.start, period.end];
    const row = await requireOne(db, QUALITY, params);
    const engagement = await requireOne(db, ENGAGEMENT, params);
    const knowledge = await requireOne(db, KNOWLEDGE, params);
    const { rows: weekly } = await db.query(LEARNED_WEEKLY, [...params, period.timezone]);

    return {
        accuracy: accuracy(row),
        review: { triaged: Number(row.triaged), rate: share(row.needs_review, row.triaged) },
        drafts: drafts(row),
        grounding: {
            tipped: Number(row.tipped),
            share: share(row.grounded, row.tipped),
            grounded_resolution_p50: numberOrNull(row.grounded_resolution_p50),
            ungrounded_resolution_p50: numberOrNull(row.ungrounded_resolution_p50),
        },
        knowledge: {
            eligible_records: Number(knowledge.eligible_records),
            learned: Number(knowledge.learned),
            recall_hits: numberOrNull(row.recall_hits),
            weekly: weekly.map((week) => ({ week: String(week.week), learned: Number(week.learned) })),
        },
        engagement: {
            tip_views: Number(engagement.tip_views),
            tip_viewed_tickets: Number(engagement.tip_viewed_tickets),
            drafts_inserted: Number(engagement.drafts_inserted),
            sources_opened: Number(engagement.sources_opened),
        },
    };
}

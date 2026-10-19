const STAFF_REPLY = "m.author_type='staff' AND m.visibility='client' AND m.delivery_state NOT IN('failed','canceled')";

const ARRAY_OR_EMPTY = (path: string) => `CASE WHEN jsonb_typeof(${path})='array' THEN ${path} ELSE '[]'::jsonb END`;

const CITED_SOURCES = `(SELECT count(DISTINCT ref)::int
  FROM jsonb_array_elements(${ARRAY_OR_EMPTY("t.suggestion->'tip'->'steps'")}) step,
       jsonb_array_elements_text(${ARRAY_OR_EMPTY("step->'case_refs'")}) ref)`;

const SPANS = `WITH t AS (
  SELECT * FROM tickets WHERE org_id=$1 AND id=ANY($2::uuid[])
    AND (purged_at IS NULL OR NOT EXISTS(SELECT 1 FROM ticket_facts f WHERE f.ticket_id=tickets.id))
), starts AS (
  SELECT t.id AS ticket_id,1 AS lifecycle,t.created_at AS started_at FROM t
  UNION ALL
  SELECT e.ticket_id,(e.detail->>'lifecycle')::int,e.created_at FROM ticket_events e JOIN t ON t.id=e.ticket_id
  WHERE e.kind='reopened' AND e.detail ? 'lifecycle'
), spans AS (
  SELECT s.*,lead(s.started_at) OVER (PARTITION BY s.ticket_id ORDER BY s.lifecycle) AS next_started_at FROM starts s
), framed AS (
  SELECT s.*,t.org_id,t.ticket_number,t.taken_at,t.tag,t.urgency,t.complexity,t.assignee_id,t.team_id,t.ai_status,
    t.suggestion,t.sla_first_response_minutes,t.sla_resolution_minutes,t.sla_breached,t.first_responded_at,
    t.sla_paused_seconds,c.rating AS closure_rating,c.reason AS closure_reason,
    c.finished_reason AS closure_finished,c.assignee_id AS closure_assignee,c.id AS closure_id,
    coalesce(c.closed_at,CASE WHEN s.next_started_at IS NULL AND t.status IN('awaiting_rating','closed')
      THEN t.closed_at END) AS span_closed_at
  FROM spans s JOIN t ON t.id=s.ticket_id
  LEFT JOIN LATERAL (SELECT * FROM closures c WHERE c.ticket_id=s.ticket_id AND c.lifecycle=s.lifecycle
    ORDER BY c.cycle_no DESC LIMIT 1) c ON true
)`;

const MESSAGE_STATS = `LEFT JOIN LATERAL (
  SELECT min(m.created_at) FILTER(WHERE ${STAFF_REPLY}) AS first_response_at,
    count(*) FILTER(WHERE ${STAFF_REPLY})::int AS staff_replies,
    count(*) FILTER(WHERE ${STAFF_REPLY} AND m.draft_origin='ai')::int AS ai_draft_replies,
    count(*) FILTER(WHERE ${STAFF_REPLY} AND m.draft_origin='macro')::int AS macro_replies,
    avg(m.draft_edit_ratio) FILTER(WHERE m.draft_origin='ai')::real AS draft_edit_ratio
  FROM messages m WHERE m.ticket_id=f.ticket_id AND m.created_at>=f.started_at
    AND m.created_at<coalesce(f.span_closed_at,f.next_started_at,'infinity')
) ms ON true
LEFT JOIN LATERAL (
  SELECT count(*) FILTER(WHERE e.kind='transferred')::int AS transfers,
    min(e.created_at) FILTER(WHERE e.kind='triaged' AND (e.detail->>'success')::boolean) AS triaged_at
  FROM ticket_events e WHERE e.ticket_id=f.ticket_id AND e.created_at>=f.started_at
    AND e.created_at<coalesce(f.span_closed_at,f.next_started_at,'infinity')
) ev ON true`;

const AI_COLUMNS = `f.lifecycle=1 AND f.ai_status='done' AND f.suggestion IS NOT NULL,
  CASE WHEN f.lifecycle=1 AND f.suggestion IS NOT NULL THEN f.suggestion->'tags'->>'tag'=f.tag END,
  CASE WHEN f.lifecycle=1 AND f.suggestion IS NOT NULL THEN f.suggestion->'tags'->>'urgency'=f.urgency END,
  CASE WHEN f.lifecycle=1 AND f.suggestion IS NOT NULL THEN f.suggestion->'tags'->>'complexity'=f.complexity END,
  f.lifecycle=1 AND coalesce((f.suggestion->>'needs_review')::boolean,false),
  CASE WHEN f.lifecycle=1 THEN ev.triaged_at END,
  f.lifecycle=1 AND coalesce(jsonb_typeof(f.suggestion->'tip')='object'
    OR jsonb_typeof(f.suggestion->'suggested_solution')='string',false),
  CASE WHEN f.lifecycle=1 THEN ${CITED_SOURCES.replaceAll('t.suggestion', 'f.suggestion')} ELSE 0 END,
  CASE WHEN f.lifecycle=1 THEN jsonb_array_length(${ARRAY_OR_EMPTY("f.suggestion->'evidence_memory_ids'")}) ELSE 0 END`;

const SLA_COLUMNS = `CASE WHEN f.lifecycle=1 AND f.sla_first_response_minutes IS NOT NULL THEN
    CASE WHEN 'first_response'=ANY(f.sla_breached) THEN false WHEN f.first_responded_at IS NOT NULL THEN true END END,
  CASE WHEN f.next_started_at IS NULL AND f.sla_resolution_minutes IS NOT NULL THEN
    CASE WHEN 'resolution'=ANY(f.sla_breached) THEN false WHEN f.span_closed_at IS NOT NULL THEN true END END`;

const CURRENT_ONLY = ['tag', 'urgency', 'complexity', 'team_id', 'waiting_seconds', 'sla_resolution_met'];

const ALWAYS = [
    'ticket_number',
    'started_at',
    'assigned_at',
    'first_response_at',
    'closed_at',
    'reopened_at',
    'assignee_id',
    'rating',
    'rating_requested',
    'finished_reason',
    'ai_classified',
    'ai_tag_kept',
    'ai_urgency_kept',
    'ai_complexity_kept',
    'review_required',
    'triaged_at',
    'tip_shown',
    'sources_cited',
    'recall_hits',
    'draft_used',
    'draft_edit_ratio',
    'staff_replies',
    'ai_draft_replies',
    'macro_replies',
    'transfers',
    'sla_response_met',
];

const UPDATES = [
    ...ALWAYS.map((column) => `${column}=EXCLUDED.${column}`),
    ...CURRENT_ONLY.map(
        (column) =>
            `${column}=CASE WHEN EXCLUDED.reopened_at IS NULL THEN EXCLUDED.${column} ELSE ticket_facts.${column} END`,
    ),
    'refreshed_at=now()',
].join(',');

export const UPSERT_FACTS = `${SPANS}
INSERT INTO ticket_facts(org_id,ticket_id,lifecycle,ticket_number,started_at,assigned_at,first_response_at,closed_at,
  reopened_at,tag,urgency,complexity,assignee_id,team_id,rating,rating_requested,finished_reason,
  ai_classified,ai_tag_kept,ai_urgency_kept,ai_complexity_kept,review_required,triaged_at,tip_shown,sources_cited,
  recall_hits,draft_used,draft_edit_ratio,staff_replies,ai_draft_replies,macro_replies,transfers,waiting_seconds,
  sla_response_met,sla_resolution_met)
SELECT f.org_id,f.ticket_id,f.lifecycle,f.ticket_number,f.started_at,
  CASE WHEN f.lifecycle=1 THEN f.taken_at ELSE f.started_at END,
  ms.first_response_at,f.span_closed_at,f.next_started_at,f.tag,f.urgency,f.complexity,
  CASE WHEN f.next_started_at IS NULL THEN f.assignee_id ELSE coalesce(f.closure_assignee,f.assignee_id) END,
  f.team_id,f.closure_rating,f.closure_id IS NOT NULL AND f.closure_reason<>'auto',f.closure_finished,
  ${AI_COLUMNS},
  ms.ai_draft_replies>0,ms.draft_edit_ratio,ms.staff_replies,ms.ai_draft_replies,ms.macro_replies,ev.transfers,
  CASE WHEN f.next_started_at IS NULL THEN f.sla_paused_seconds ELSE 0 END,
  ${SLA_COLUMNS}
FROM framed f ${MESSAGE_STATS}
ON CONFLICT (ticket_id,lifecycle) DO UPDATE SET ${UPDATES}
RETURNING ticket_id,lifecycle,started_at,first_response_at,closed_at,waiting_seconds`;

export const CHANGED_TICKETS = `SELECT id FROM tickets WHERE org_id=$1 AND (updated_at>$2::timestamptz OR status<>'closed'
    OR id IN(SELECT ticket_id FROM closures WHERE org_id=$1 AND rated_at>$2::timestamptz)
    OR id IN(SELECT ticket_id FROM ticket_events WHERE org_id=$1 AND created_at>$2::timestamptz AND kind IN('transferred','triaged')))
  AND id>$3 ORDER BY id LIMIT $4`;

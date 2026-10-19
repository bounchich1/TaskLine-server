CREATE TABLE ticket_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  ticket_id uuid NOT NULL,
  employee_id uuid,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z_]*$'),
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, ticket_id) REFERENCES tickets(org_id, id)
);
CREATE INDEX ticket_events_ticket ON ticket_events(ticket_id, kind, created_at);
CREATE INDEX ticket_events_recent ON ticket_events(org_id, kind, created_at);

ALTER TABLE messages
  ADD COLUMN draft_origin text CHECK (draft_origin IN ('ai', 'macro')),
  ADD COLUMN draft_edit_ratio real CHECK (draft_edit_ratio BETWEEN 0 AND 1);

ALTER TABLE closures ADD COLUMN assignee_id uuid;

UPDATE closures c SET assignee_id = CASE WHEN c.lifecycle = t.lifecycle THEN coalesce(t.assignee_id, c.closed_by) ELSE c.closed_by END
FROM tickets t WHERE t.id = c.ticket_id;

CREATE TABLE ticket_facts (
  org_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  lifecycle integer NOT NULL,
  ticket_number integer NOT NULL,
  started_at timestamptz NOT NULL,
  assigned_at timestamptz,
  first_response_at timestamptz,
  closed_at timestamptz,
  reopened_at timestamptz,
  tag text NOT NULL,
  urgency text NOT NULL,
  complexity text NOT NULL,
  assignee_id uuid,
  team_id uuid,
  rating integer,
  rating_requested boolean NOT NULL DEFAULT false,
  finished_reason text,
  ai_classified boolean NOT NULL DEFAULT false,
  ai_tag_kept boolean,
  ai_urgency_kept boolean,
  ai_complexity_kept boolean,
  review_required boolean NOT NULL DEFAULT false,
  triaged_at timestamptz,
  tip_shown boolean NOT NULL DEFAULT false,
  sources_cited integer NOT NULL DEFAULT 0,
  recall_hits integer NOT NULL DEFAULT 0,
  draft_used boolean NOT NULL DEFAULT false,
  draft_edit_ratio real,
  staff_replies integer NOT NULL DEFAULT 0,
  ai_draft_replies integer NOT NULL DEFAULT 0,
  macro_replies integer NOT NULL DEFAULT 0,
  transfers integer NOT NULL DEFAULT 0,
  waiting_seconds integer NOT NULL DEFAULT 0,
  first_response_business_seconds integer,
  resolution_business_seconds integer,
  sla_response_met boolean,
  sla_resolution_met boolean,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, lifecycle)
);
CREATE INDEX ticket_facts_started ON ticket_facts(org_id, started_at);
CREATE INDEX ticket_facts_closed ON ticket_facts(org_id, closed_at);
CREATE INDEX ticket_facts_assignee ON ticket_facts(org_id, assignee_id, closed_at);

CREATE TABLE facts_refresh (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  watermark timestamptz NOT NULL DEFAULT '-infinity',
  ran_at timestamptz
);

CREATE TABLE report_digests (
  org_id uuid NOT NULL REFERENCES organizations(id),
  week_start date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, week_start)
);

CREATE TABLE report_grants (
  hash text PRIMARY KEY,
  org_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  session_hash text NOT NULL,
  report text NOT NULL,
  format text NOT NULL CHECK (format IN ('csv', 'xlsx')),
  period_from date NOT NULL,
  period_to date NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '60 seconds',
  FOREIGN KEY (org_id, employee_id) REFERENCES employees(org_id, id)
);

INSERT INTO ticket_events(org_id, ticket_id, employee_id, kind, detail, created_at)
SELECT a.org_id, t.id, a.actor_id, 'reopened',
  jsonb_build_object('lifecycle', 1 + row_number() OVER (PARTITION BY t.id ORDER BY a.created_at)), a.created_at
FROM audit a JOIN tickets t ON t.org_id = a.org_id AND t.id::text = a.object_id
WHERE a.action = 'ticket.reopen';

INSERT INTO ticket_events(org_id, ticket_id, employee_id, kind, detail, created_at)
SELECT a.org_id, t.id, a.actor_id, 'transferred', jsonb_build_object('from', a.actor_id), a.created_at
FROM audit a JOIN tickets t ON t.org_id = a.org_id AND t.id::text = a.object_id
WHERE a.action = 'ticket.transfer';

INSERT INTO ticket_events(org_id, ticket_id, employee_id, kind, detail, created_at)
SELECT a.org_id, t.id, a.actor_id, 'source_opened', jsonb_build_object('memory_id', a.detail->>'memory_id'), a.created_at
FROM audit a JOIN tickets t ON t.org_id = a.org_id AND t.id::text = a.detail->>'from_ticket_id'
WHERE a.action = 'ticket.source_opened';

INSERT INTO ticket_events(org_id, ticket_id, employee_id, kind, detail, created_at)
SELECT a.org_id, t.id, NULL, 'triaged',
  jsonb_build_object('success', coalesce((a.detail->>'success')::boolean, false), 'reason', a.detail->>'reason'), a.created_at
FROM audit a JOIN tickets t ON t.org_id = a.org_id AND t.id::text = a.object_id
WHERE a.action = 'ai.triage';

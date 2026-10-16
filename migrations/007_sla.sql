CREATE TABLE sla_settings (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  enabled boolean NOT NULL DEFAULT true,
  week jsonb NOT NULL DEFAULT '{"1":[["09:00","18:00"]],"2":[["09:00","18:00"]],"3":[["09:00","18:00"]],"4":[["09:00","18:00"]],"5":[["09:00","18:00"]],"6":[],"7":[]}',
  holidays date[] NOT NULL DEFAULT '{}',
  workdays date[] NOT NULL DEFAULT '{}',
  notify_max boolean NOT NULL DEFAULT false,
  client_eta boolean NOT NULL DEFAULT false,
  waiting_reminder_hours integer NOT NULL DEFAULT 24 CHECK (waiting_reminder_hours BETWEEN 0 AND 720),
  waiting_close_hours integer NOT NULL DEFAULT 72 CHECK (waiting_close_hours BETWEEN 0 AND 2160),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE sla_policies (
  org_id uuid NOT NULL REFERENCES organizations(id),
  urgency text NOT NULL,
  tag text NOT NULL DEFAULT '*',
  first_response_minutes integer NOT NULL CHECK (first_response_minutes BETWEEN 1 AND 43200),
  resolution_minutes integer NOT NULL CHECK (resolution_minutes BETWEEN 1 AND 43200),
  PRIMARY KEY (org_id, urgency, tag)
);

ALTER TABLE tickets
  ADD COLUMN sla_first_response_minutes integer,
  ADD COLUMN sla_resolution_minutes integer,
  ADD COLUMN first_response_warn_at timestamptz,
  ADD COLUMN first_response_due_at timestamptz,
  ADD COLUMN first_responded_at timestamptz,
  ADD COLUMN resolution_started_at timestamptz,
  ADD COLUMN resolution_warn_at timestamptz,
  ADD COLUMN resolution_due_at timestamptz,
  ADD COLUMN waiting_since timestamptz,
  ADD COLUMN waiting_reminded boolean NOT NULL DEFAULT false,
  ADD COLUMN sla_paused_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN first_response_stage smallint NOT NULL DEFAULT 0,
  ADD COLUMN resolution_stage smallint NOT NULL DEFAULT 0,
  ADD COLUMN sla_breached text[] NOT NULL DEFAULT '{}',
  ADD COLUMN sla_next_check_at timestamptz;

UPDATE tickets t SET first_responded_at = staff.first_at
FROM (
  SELECT ticket_id, min(created_at) AS first_at FROM messages
  WHERE author_type = 'staff' AND delivery_state = 'delivered' GROUP BY ticket_id
) staff
WHERE staff.ticket_id = t.id;

UPDATE tickets SET resolution_started_at = created_at;

CREATE INDEX ticket_sla_check ON tickets(org_id, sla_next_check_at) WHERE sla_next_check_at IS NOT NULL;
CREATE INDEX ticket_waiting ON tickets(org_id, waiting_since) WHERE waiting_since IS NOT NULL;

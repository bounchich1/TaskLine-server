CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE incident_settings (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  detection boolean NOT NULL DEFAULT true,
  auto_link boolean NOT NULL DEFAULT false,
  window_minutes integer NOT NULL DEFAULT 15 CHECK (window_minutes BETWEEN 5 AND 120),
  min_tickets integer NOT NULL DEFAULT 8 CHECK (min_tickets BETWEEN 2 AND 1000),
  spike_factor numeric(5,2) NOT NULL DEFAULT 4 CHECK (spike_factor BETWEEN 1 AND 50),
  relink_hours integer NOT NULL DEFAULT 6 CHECK (relink_hours BETWEEN 0 AND 72),
  detected_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  tag text NOT NULL,
  status text NOT NULL CHECK (status IN ('suggested', 'open', 'resolved', 'dismissed')),
  public_message text NOT NULL DEFAULT '' CHECK (length(public_message) <= 2000),
  final_message text NOT NULL DEFAULT '' CHECK (length(final_message) <= 2000),
  eta timestamptz,
  match_terms text[] NOT NULL DEFAULT '{}',
  request_rating boolean NOT NULL DEFAULT false,
  detection jsonb,
  learning_ticket_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  opened_at timestamptz,
  resolved_at timestamptz,
  dismissed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES employees(org_id, id)
);
CREATE INDEX incidents_status ON incidents(org_id, status, created_at DESC);
CREATE UNIQUE INDEX incident_open_suggestion ON incidents(org_id, tag) WHERE status = 'suggested';

CREATE TABLE incident_tickets (
  org_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_by uuid,
  auto boolean NOT NULL DEFAULT false,
  PRIMARY KEY (incident_id, ticket_id),
  FOREIGN KEY (org_id, incident_id) REFERENCES incidents(org_id, id),
  FOREIGN KEY (org_id, ticket_id) REFERENCES tickets(org_id, id)
);
CREATE INDEX incident_tickets_ticket ON incident_tickets(ticket_id);

CREATE TABLE incident_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opened', 'message', 'eta', 'resolved', 'reopened', 'dismissed')),
  text text NOT NULL DEFAULT '' CHECK (length(text) <= 2000),
  eta timestamptz,
  author_id uuid,
  broadcast boolean NOT NULL DEFAULT false,
  recipients integer NOT NULL DEFAULT 0,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, incident_id) REFERENCES incidents(org_id, id)
);
CREATE INDEX incident_updates_incident ON incident_updates(incident_id, created_at);

CREATE INDEX ticket_created ON tickets(org_id, created_at);

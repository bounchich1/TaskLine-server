CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  supervisor_id uuid,
  auto_assign boolean NOT NULL DEFAULT false,
  strategy text NOT NULL DEFAULT 'least_loaded' CHECK (strategy IN ('round_robin', 'least_loaded', 'skills')),
  capacity integer NOT NULL DEFAULT 5 CHECK (capacity BETWEEN 1 AND 100),
  offer_timeout_seconds integer NOT NULL DEFAULT 180 CHECK (offer_timeout_seconds BETWEEN 30 AND 3600),
  allow_self_take boolean NOT NULL DEFAULT true,
  last_offered_to uuid,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, supervisor_id) REFERENCES employees(org_id, id)
);
CREATE UNIQUE INDEX team_name ON teams(org_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE team_members (
  org_id uuid NOT NULL,
  team_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  skills text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (team_id, employee_id),
  FOREIGN KEY (org_id, team_id) REFERENCES teams(org_id, id),
  FOREIGN KEY (org_id, employee_id) REFERENCES employees(org_id, id)
);
CREATE INDEX team_members_employee ON team_members(org_id, employee_id);

CREATE TABLE routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  priority integer NOT NULL,
  match jsonb NOT NULL DEFAULT '{}',
  team_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (org_id, team_id) REFERENCES teams(org_id, id)
);
CREATE INDEX routing_rules_order ON routing_rules(org_id, priority);

ALTER TABLE tickets
  ADD COLUMN team_id uuid,
  ADD COLUMN routed_at timestamptz,
  ADD COLUMN offered_to uuid,
  ADD COLUMN offered_at timestamptz,
  ADD COLUMN offer_due_at timestamptz,
  ADD COLUMN offer_skipped uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT tickets_team_fk FOREIGN KEY (org_id, team_id) REFERENCES teams(org_id, id);

UPDATE tickets SET routed_at = created_at;

CREATE INDEX ticket_team ON tickets(org_id, team_id, status);
CREATE INDEX ticket_offer_due ON tickets(org_id, offer_due_at) WHERE offer_due_at IS NOT NULL;
CREATE INDEX ticket_unrouted ON tickets(org_id, created_at) WHERE routed_at IS NULL;

ALTER TABLE employees
  ADD COLUMN presence text NOT NULL DEFAULT 'offline' CHECK (presence IN ('online', 'break', 'offline')),
  ADD COLUMN presence_at timestamptz,
  ADD COLUMN presence_seen_at timestamptz;

CREATE TABLE presence_log (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  presence text NOT NULL CHECK (presence IN ('online', 'break', 'offline')),
  started_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, employee_id) REFERENCES employees(org_id, id)
);
CREATE INDEX presence_log_employee ON presence_log(org_id, employee_id, started_at);

CREATE TABLE macros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  owner_id uuid,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  actions jsonb NOT NULL DEFAULT '{}',
  uses integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, owner_id) REFERENCES employees(org_id, id)
);
CREATE INDEX macros_owner ON macros(org_id, owner_id);

ALTER TABLE messages
  ADD COLUMN visibility text NOT NULL DEFAULT 'client' CHECK (visibility IN ('client', 'internal')),
  ADD COLUMN learnable boolean NOT NULL DEFAULT false,
  ADD COLUMN mentions uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN macro_id uuid;

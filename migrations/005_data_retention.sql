ALTER TABLE tickets ADD COLUMN purged_at timestamptz;
ALTER TABLE tickets ADD COLUMN purge_reason text CHECK (purge_reason IN ('retention', 'erasure'));
CREATE INDEX ticket_retention ON tickets(org_id, closed_at) WHERE status = 'closed' AND purged_at IS NULL;

ALTER TABLE clients ADD COLUMN erased_at timestamptz;

CREATE TABLE export_grants (
  hash text PRIMARY KEY, org_id uuid NOT NULL, client_id uuid NOT NULL, employee_id uuid NOT NULL,
  session_hash text NOT NULL, expires_at timestamptz NOT NULL DEFAULT now() + interval '60 seconds',
  FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id),
  FOREIGN KEY (org_id, employee_id) REFERENCES employees(org_id, id)
);

ALTER SEQUENCE ticket_number_seq MAXVALUE 2147483647;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_ticket_number_check;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_ticket_number_key;
ALTER TABLE tickets ADD CONSTRAINT tickets_org_ticket_number_key UNIQUE (org_id, ticket_number);
ALTER TABLE tickets ADD CONSTRAINT tickets_ticket_number_positive CHECK (ticket_number > 0);

ALTER TABLE organizations ADD COLUMN ticket_sequence text NOT NULL DEFAULT 'ticket_number_seq';
ALTER TABLE organizations ADD COLUMN ai_quota integer CHECK (ai_quota BETWEEN 1 AND 15);

ALTER TABLE ai_permits ADD COLUMN org_id uuid REFERENCES organizations(id);
UPDATE ai_permits p SET org_id = c.org_id
FROM ai_calls c WHERE p.state <> 'free' AND c.id = p.holder;
CREATE INDEX ai_permits_busy_org ON ai_permits(org_id) WHERE state <> 'free';

CREATE TABLE max_send_pacing (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  next_at timestamptz NOT NULL DEFAULT now()
);

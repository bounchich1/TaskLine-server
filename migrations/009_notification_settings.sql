ALTER TABLE notifications ADD COLUMN payload jsonb NOT NULL DEFAULT '{}';

CREATE INDEX notifications_recent ON notifications(employee_id, created_at DESC);
CREATE INDEX notifications_unread_ticket ON notifications(employee_id, ticket_id) WHERE read_at IS NULL;

CREATE TABLE notification_settings (
  org_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  new_tickets text NOT NULL DEFAULT 'all' CHECK (new_tickets IN ('all', 'topics', 'off')),
  topics text[] NOT NULL DEFAULT '{}',
  max_alerts boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, employee_id),
  FOREIGN KEY (org_id, employee_id) REFERENCES employees(org_id, id)
);

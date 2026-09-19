CREATE SEQUENCE ticket_number_seq MINVALUE 1 MAXVALUE 999999 START 1 NO CYCLE CACHE 1;
CREATE TABLE organizations (
  id uuid PRIMARY KEY, name text NOT NULL, timezone text NOT NULL,
  cursor bigint NOT NULL DEFAULT 0, version integer NOT NULL DEFAULT 1,
  settings jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  max_user_id text NOT NULL, name text NOT NULL, role text NOT NULL CHECK(role IN ('support','supervisor','admin')),
  blocked boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,max_user_id), UNIQUE(org_id,id)
);
CREATE TABLE staff_sessions (
  hash text PRIMARY KEY, org_id uuid NOT NULL, employee_id uuid NOT NULL,
  employee_version integer NOT NULL, csrf_hash text NOT NULL, launch_hash text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '8 hours', revoked boolean NOT NULL DEFAULT false,
  FOREIGN KEY(org_id,employee_id) REFERENCES employees(org_id,id)
);
CREATE INDEX session_expiry ON staff_sessions(expires_at);
CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  max_user_id text NOT NULL, chat_id text NOT NULL,
  consent_state text NOT NULL DEFAULT 'absent' CHECK(consent_state IN ('absent','granted','declined','withdrawn')),
  consent_version text, consent_at timestamptz, consent_revision integer NOT NULL DEFAULT 0,
  next_ingress bigint NOT NULL DEFAULT 0, last_send_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,max_user_id), UNIQUE(org_id,id)
);
CREATE TABLE consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, client_id uuid NOT NULL,
  action text NOT NULL, policy_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(org_id,client_id) REFERENCES clients(org_id,id)
);
CREATE TABLE preconsent_buffers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, client_id uuid NOT NULL,
  source_key text NOT NULL UNIQUE, payload text NOT NULL, byte_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
  FOREIGN KEY(org_id,client_id) REFERENCES clients(org_id,id)
);
CREATE TABLE callback_actions (
  nonce text PRIMARY KEY, org_id uuid NOT NULL, client_id uuid NOT NULL, action text NOT NULL,
  policy_version text, cycle_id uuid, value integer, used_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
  FOREIGN KEY(org_id,client_id) REFERENCES clients(org_id,id)
);
CREATE TABLE dictionaries (
  org_id uuid NOT NULL REFERENCES organizations(id), dimension text NOT NULL CHECK(dimension IN ('tag','urgency','complexity')),
  code text NOT NULL CHECK(code ~ '^[a-z][a-z0-9_]*$'), label text NOT NULL, rank integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  PRIMARY KEY(org_id,dimension,code)
);
CREATE TABLE templates (
  org_id uuid NOT NULL REFERENCES organizations(id), code text NOT NULL, body text NOT NULL,
  version integer NOT NULL DEFAULT 1, PRIMARY KEY(org_id,code)
);
CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, client_id uuid NOT NULL,
  ticket_number integer NOT NULL DEFAULT nextval('ticket_number_seq') UNIQUE CHECK(ticket_number BETWEEN 1 AND 999999),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','awaiting_rating','closed')),
  description text NOT NULL, consent_version text NOT NULL, consent_revision integer NOT NULL,
  assignee_id uuid, taken_at timestamptz, closed_at timestamptz, closed_by uuid,
  current_cycle_id uuid, lifecycle integer NOT NULL DEFAULT 1, version integer NOT NULL DEFAULT 1,
  last_message_seq integer NOT NULL DEFAULT 0, tag text NOT NULL DEFAULT 'undefined',
  urgency text NOT NULL DEFAULT 'medium', complexity text NOT NULL DEFAULT 'medium',
  tag_revision integer NOT NULL DEFAULT 0, urgency_revision integer NOT NULL DEFAULT 0, complexity_revision integer NOT NULL DEFAULT 0,
  classification_labels jsonb NOT NULL DEFAULT '{}', ai_status text NOT NULL DEFAULT 'pending',
  review_required boolean NOT NULL DEFAULT false, suggestion jsonb, suggestion_stale boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,id), FOREIGN KEY(org_id,client_id) REFERENCES clients(org_id,id),
  FOREIGN KEY(org_id,assignee_id) REFERENCES employees(org_id,id),
  CHECK(status <> 'in_progress' OR assignee_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_client_slot ON tickets(org_id,client_id) WHERE status IN ('open','in_progress','awaiting_rating');
CREATE INDEX ticket_queue ON tickets(org_id,status,created_at,id);
CREATE INDEX ticket_assignee ON tickets(org_id,assignee_id,status);
CREATE INDEX ticket_text ON tickets USING gin(to_tsvector('russian',description));
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, ticket_id uuid NOT NULL,
  seq integer NOT NULL, author_type text NOT NULL CHECK(author_type IN ('client','staff','bot','system')),
  author_id uuid, text text NOT NULL DEFAULT '', provider_ref text,
  provider_sent_at timestamptz, delivery_state text NOT NULL DEFAULT 'received', revision integer NOT NULL DEFAULT 1,
  deleted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(ticket_id,seq), UNIQUE(org_id,id), FOREIGN KEY(org_id,ticket_id) REFERENCES tickets(org_id,id)
);
CREATE UNIQUE INDEX inbound_provider_identity ON messages(org_id,provider_ref) WHERE provider_ref IS NOT NULL AND author_type='client';
CREATE INDEX message_text ON messages USING gin(to_tsvector('russian',text));
CREATE TABLE message_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), message_id uuid NOT NULL REFERENCES messages(id),
  revision integer NOT NULL, encrypted_previous text NOT NULL, source_key text NOT NULL UNIQUE,
  deleted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, ticket_id uuid NOT NULL,
  cycle_no integer NOT NULL, lifecycle integer NOT NULL, cutoff_seq integer NOT NULL,
  closed_by uuid NOT NULL, reason text NOT NULL DEFAULT 'normal', note text NOT NULL DEFAULT '',
  closed_at timestamptz NOT NULL DEFAULT now(), reminder_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  expires_at timestamptz NOT NULL DEFAULT now()+interval '72 hours', reminder_created boolean NOT NULL DEFAULT false,
  invalid_attempts integer NOT NULL DEFAULT 0, rating integer CHECK(rating BETWEEN 1 AND 10), rated_at timestamptz,
  finished_reason text, invalidated boolean NOT NULL DEFAULT false, learning_status text NOT NULL DEFAULT 'queued',
  snapshot text, snapshot_hash text, coverage jsonb, UNIQUE(ticket_id,cycle_no), UNIQUE(org_id,id),
  FOREIGN KEY(org_id,ticket_id) REFERENCES tickets(org_id,id)
);
CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, ticket_id uuid NOT NULL,
  message_id uuid, owner_id uuid, filename text NOT NULL, declared_mime text, mime text, bytes bigint,
  kind text NOT NULL CHECK(kind IN ('image','video','file')), source_ref text, object_key text, sha256 text,
  status text NOT NULL DEFAULT 'uploading', extraction text, extraction_status text NOT NULL DEFAULT 'unsupported',
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,id), FOREIGN KEY(org_id,ticket_id) REFERENCES tickets(org_id,id),
  FOREIGN KEY(org_id,message_id) REFERENCES messages(org_id,id), FOREIGN KEY(org_id,owner_id) REFERENCES employees(org_id,id)
);
CREATE TABLE download_grants (
  hash text PRIMARY KEY, org_id uuid NOT NULL, attachment_id uuid NOT NULL, employee_id uuid NOT NULL,
  session_hash text NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '60 seconds',
  FOREIGN KEY(org_id,attachment_id) REFERENCES attachments(org_id,id)
);
CREATE TABLE inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  source_key text NOT NULL, client_id uuid, ingress_seq bigint, kind text NOT NULL,
  payload text, state text NOT NULL DEFAULT 'pending', reason text, attempts integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, UNIQUE(org_id,source_key)
);
CREATE INDEX pending_inbox ON inbox(org_id,client_id,ingress_seq) WHERE state='pending';
CREATE TABLE deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, client_id uuid NOT NULL,
  ticket_id uuid, message_id uuid, cycle_id uuid, logical_key text NOT NULL UNIQUE,
  chat_seq bigint GENERATED ALWAYS AS IDENTITY, kind text NOT NULL, body jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0, generation integer NOT NULL DEFAULT 0,
  staff_id uuid, staff_version integer, provider_ref text, reason text, started_at timestamptz,
  due_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(org_id,client_id) REFERENCES clients(org_id,id), FOREIGN KEY(org_id,ticket_id) REFERENCES tickets(org_id,id),
  FOREIGN KEY(org_id,message_id) REFERENCES messages(org_id,id)
);
CREATE INDEX delivery_head ON deliveries(org_id,client_id,chat_seq) WHERE state IN ('queued','sending','retry_wait','unknown');
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  logical_key text NOT NULL UNIQUE, kind text NOT NULL, ref_id uuid NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, generation integer NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz, published_at timestamptz,
  reason text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX jobs_due ON jobs(state,due_at);
CREATE TABLE ai_settings (id integer PRIMARY KEY CHECK(id=1), cap integer NOT NULL CHECK(cap BETWEEN 10 AND 15));
CREATE TABLE ai_permits (
  slot integer PRIMARY KEY CHECK(slot BETWEEN 1 AND 15), generation integer NOT NULL DEFAULT 0,
  holder uuid, state text NOT NULL DEFAULT 'free' CHECK(state IN ('free','running','uncertain')),
  started_at timestamptz, provider_ref text
);
INSERT INTO ai_permits(slot) SELECT generate_series(1,15);
CREATE TABLE ai_calls (
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), job_id uuid NOT NULL REFERENCES jobs(id),
  step_key text NOT NULL, input_hash text NOT NULL, permit integer REFERENCES ai_permits(slot), generation integer,
  state text NOT NULL DEFAULT 'running', response text, reason text, usage jsonb,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, UNIQUE(job_id,step_key)
);
CREATE TABLE ai_checkpoints (
  job_id uuid NOT NULL REFERENCES jobs(id), step_key text NOT NULL, output text NOT NULL, input_hash text NOT NULL,
  covered_ids jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(job_id,step_key)
);
CREATE TABLE memory_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, ticket_id uuid NOT NULL, closure_id uuid NOT NULL,
  source_key text NOT NULL UNIQUE, content_hash text NOT NULL, content jsonb NOT NULL, receipt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  eligible boolean NOT NULL DEFAULT false, state text NOT NULL DEFAULT 'pending', upstream_id text,
  write_generation integer NOT NULL DEFAULT 0, reason text, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '180 days',
  FOREIGN KEY(org_id,ticket_id) REFERENCES tickets(org_id,id), FOREIGN KEY(org_id,closure_id) REFERENCES closures(org_id,id)
);
CREATE TABLE memory_external_refs (
  record_id uuid NOT NULL REFERENCES memory_records(id), upstream_id text NOT NULL, deleted_at timestamptz,
  PRIMARY KEY(record_id,upstream_id)
);
CREATE TABLE memory_writer (
  org_id uuid PRIMARY KEY REFERENCES organizations(id), holder uuid, started_at timestamptz
);
CREATE TABLE deletion_tombstones (
  org_id uuid NOT NULL, client_id uuid NOT NULL, consent_revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,client_id,consent_revision)
);
CREATE TABLE ui_events (
  org_id uuid NOT NULL REFERENCES organizations(id), cursor bigint NOT NULL, type text NOT NULL,
  ticket_id uuid, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,cursor)
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, employee_id uuid NOT NULL,
  cursor bigint NOT NULL, type text NOT NULL, ticket_id uuid, read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(employee_id,cursor),
  FOREIGN KEY(org_id,employee_id) REFERENCES employees(org_id,id)
);
CREATE TABLE audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  actor_id uuid, action text NOT NULL, object_id text, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE command_keys (
  principal text NOT NULL, route text NOT NULL, key text NOT NULL, request_hash text NOT NULL,
  response jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(principal,route,key)
);
CREATE TABLE max_rate_limit (id integer PRIMARY KEY CHECK(id=1), next_at timestamptz NOT NULL DEFAULT now());
INSERT INTO max_rate_limit(id) VALUES(1);

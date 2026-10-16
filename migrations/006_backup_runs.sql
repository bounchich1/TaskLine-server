CREATE TABLE backup_runs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('full', 'diff', 'incr', 'verify')),
  label text NOT NULL DEFAULT '',
  finished_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX backup_runs_recent ON backup_runs(kind, finished_at DESC);

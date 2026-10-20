CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cameras (
  id UUID PRIMARY KEY,
  camera_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  area TEXT NOT NULL,
  ip_address INET,
  map_x NUMERIC(6, 3),
  map_y NUMERIC(6, 3),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS camera_streams (
  camera_id UUID PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
  encrypted_rtsp TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY,
  camera_id UUID REFERENCES cameras(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_history (
  id UUID PRIMARY KEY,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  setting_key TEXT PRIMARY KEY,
  setting_value JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS division TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE reports ADD COLUMN IF NOT EXISTS report_code TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS camera_code TEXT NOT NULL DEFAULT '';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_status_check;
ALTER TABLE reports ADD CONSTRAINT reports_status_check CHECK (status IN ('open', 'progress', 'resolved'));
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_priority_check;
ALTER TABLE reports ADD CONSTRAINT reports_priority_check CHECK (priority IN ('normal', 'high', 'critical'));
CREATE UNIQUE INDEX IF NOT EXISTS reports_report_code_idx ON reports(report_code);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status);

CREATE INDEX IF NOT EXISTS reports_camera_id_idx ON reports(camera_id);
CREATE INDEX IF NOT EXISTS activity_history_created_at_idx ON activity_history(created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

-- Founder Engine, Milestone 3 Phase 1: durable venture record, deal flow, lessons memory.
-- Portable PostgreSQL (>= 13). No extensions required (uses built-in sha256 and gen_random_uuid).
--
-- Tenant isolation: every tenant table has FORCE ROW LEVEL SECURITY keyed on the per-transaction
-- setting app.user_id, so isolation holds even for the table owner and even if application code
-- forgets a WHERE clause. Auth tables (fe_users, fe_sessions) are reached only through auth code.
--
-- Immutability: evidence tables reject UPDATE/DELETE/TRUNCATE via triggers. fe_audit_events is
-- additionally hash-chained per tenant (sha256 over the previous hash + the canonical row).

CREATE TABLE fe_users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' in email) > 1),
  pw_hash     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fe_sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES fe_users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX fe_sessions_user ON fe_sessions(user_id);

CREATE OR REPLACE FUNCTION fe_current_user() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE TABLE fe_ventures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES fe_users(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Curation runs: the full Milestone 1 result, stored verbatim (receipts included). Immutable.
CREATE TABLE fe_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES fe_users(id),
  venture_id  uuid NOT NULL REFERENCES fe_ventures(id),
  intent      text NOT NULL,
  status      text NOT NULL,
  run         jsonb NOT NULL,
  lessons_consulted uuid[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Pitch versions: founder statements + the generated script, pinned to one run. Immutable.
CREATE TABLE fe_pitches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES fe_users(id),
  venture_id  uuid NOT NULL REFERENCES fe_ventures(id),
  run_id      uuid NOT NULL REFERENCES fe_runs(id),
  version     int  NOT NULL,
  founder     jsonb NOT NULL,
  facts_hash  text NOT NULL,
  script      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, version)
);

CREATE TYPE fe_stage AS ENUM ('researching','invited','viewed','qa','followup','founder_meeting','interest_recorded','passed');

CREATE TABLE fe_investors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES fe_users(id),
  venture_id  uuid NOT NULL REFERENCES fe_ventures(id),
  name        text NOT NULL,
  firm        text,
  email       text,
  focus       text[] NOT NULL DEFAULT '{}',
  focus_basis text,
  stage       fe_stage NOT NULL DEFAULT 'researching',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Every stage change, including automatic ones. Immutable.
CREATE TABLE fe_stage_transitions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES fe_users(id),
  venture_id  uuid NOT NULL REFERENCES fe_ventures(id),
  investor_id uuid NOT NULL REFERENCES fe_investors(id),
  from_stage  fe_stage,
  to_stage    fe_stage NOT NULL,
  actor       text NOT NULL,   -- 'founder:<user id>' or 'system:<event>'
  note        text,
  at          timestamptz NOT NULL DEFAULT now()
);

-- Invitations: issued only with an explicit founder authorization record. Token stored as a hash.
CREATE TABLE fe_invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES fe_users(id),
  venture_id    uuid NOT NULL REFERENCES fe_ventures(id),
  investor_id   uuid NOT NULL REFERENCES fe_investors(id),
  pitch_id      uuid NOT NULL REFERENCES fe_pitches(id),
  access_level  text NOT NULL CHECK (access_level IN ('identified','accredited')),
  verified_by   text,
  token_hash    text NOT NULL UNIQUE,
  authorized_by uuid NOT NULL REFERENCES fe_users(id),
  authorization_statement text NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  CHECK (access_level <> 'accredited' OR (verified_by IS NOT NULL AND length(verified_by) > 2))
);

CREATE TABLE fe_pitch_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES fe_users(id),
  venture_id    uuid NOT NULL REFERENCES fe_ventures(id),
  investor_id   uuid NOT NULL REFERENCES fe_investors(id),
  pitch_id      uuid NOT NULL REFERENCES fe_pitches(id),
  invitation_id uuid REFERENCES fe_invitations(id),
  channel       text NOT NULL CHECK (channel IN ('investor_link','founder_recorded')),
  started_at    timestamptz NOT NULL DEFAULT now()
);

-- Q&A turns. Immutable.
CREATE TABLE fe_qa (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES fe_users(id),
  venture_id  uuid NOT NULL REFERENCES fe_ventures(id),
  session_id  uuid NOT NULL REFERENCES fe_pitch_sessions(id),
  question    text NOT NULL,
  persona     text NOT NULL,
  answer      text NOT NULL,
  cites       text[] NOT NULL DEFAULT '{}',
  escalate    boolean NOT NULL,
  mode        text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fe_followups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES fe_users(id),
  venture_id  uuid NOT NULL REFERENCES fe_ventures(id),
  investor_id uuid NOT NULL REFERENCES fe_investors(id),
  qa_id       uuid REFERENCES fe_qa(id),
  text        text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dropped')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Lessons: verified failures and the corrections that fixed them. Advisory only. Immutable;
-- a better lesson supersedes an older one instead of editing it.
CREATE TABLE fe_lessons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES fe_users(id),
  component    text NOT NULL,
  environment  text NOT NULL,
  symptom      text NOT NULL,
  cause        text NOT NULL,
  correction   text NOT NULL,
  evidence_ref text NOT NULL,      -- run id or receipt hash that proves the correction worked
  supersedes   uuid REFERENCES fe_lessons(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fe_lessons_lookup ON fe_lessons(owner_id, component, environment);

-- Append-only, hash-chained audit trail.
CREATE TABLE fe_audit_events (
  seq         bigserial PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES fe_users(id),
  venture_id  uuid,
  actor       text NOT NULL,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  detail      jsonb NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash   text NOT NULL,
  hash        text NOT NULL
);
CREATE INDEX fe_audit_owner ON fe_audit_events(owner_id, seq);

CREATE OR REPLACE FUNCTION fe_audit_text(e fe_audit_events) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT e.prev_hash || '|' || e.owner_id::text || '|' || coalesce(e.venture_id::text, '') || '|' || e.actor || '|' ||
         e.action || '|' || e.entity || '|' || coalesce(e.entity_id, '') || '|' || e.detail::text || '|' ||
         to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

CREATE OR REPLACE FUNCTION fe_audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fe_audit:' || NEW.owner_id::text));
  SELECT coalesce((SELECT hash FROM fe_audit_events WHERE owner_id = NEW.owner_id ORDER BY seq DESC LIMIT 1), 'genesis')
    INTO NEW.prev_hash;
  NEW.at := clock_timestamp();
  NEW.hash := encode(sha256(convert_to(fe_audit_text(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER fe_audit_chain BEFORE INSERT ON fe_audit_events FOR EACH ROW EXECUTE FUNCTION fe_audit_chain();

CREATE OR REPLACE FUNCTION fe_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fe: % on % is not permitted (immutable evidence)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fe_audit_events','fe_runs','fe_pitches','fe_qa','fe_stage_transitions','fe_lessons'] LOOP
    EXECUTE format('CREATE TRIGGER %I_no_update BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fe_immutable()', t, t);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fe_immutable()', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['fe_ventures','fe_runs','fe_pitches','fe_investors','fe_stage_transitions','fe_invitations',
                           'fe_pitch_sessions','fe_qa','fe_followups','fe_lessons','fe_audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I_tenant ON %I USING (owner_id = fe_current_user()) WITH CHECK (owner_id = fe_current_user())', t, t);
  END LOOP;
END $$;

-- Investor links: an invitation row is readable by its token hash (and nothing else) before the
-- tenant context is known; the service then sets app.user_id to the invitation owner.
CREATE POLICY fe_invitations_by_token ON fe_invitations FOR SELECT
  USING (token_hash = nullif(current_setting('app.invite_token_hash', true), ''));

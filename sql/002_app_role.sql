-- Least-privilege application role. Every request transaction runs `SET LOCAL ROLE fe_app`, so:
--  * row-level security applies even when the connection user is a superuser or has BYPASSRLS
--    (managed Postgres owner roles often do; the CI postgres image user is a superuser)
--  * the app cannot ALTER tables, disable triggers, TRUNCATE, or DELETE evidence
-- Migrations keep running as the connection user (owner).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fe_app') THEN
    CREATE ROLE fe_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  EXECUTE format('GRANT fe_app TO %I', current_user);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO fe_app', current_schema());
END $$;

GRANT SELECT, INSERT ON fe_users TO fe_app;
GRANT SELECT, INSERT, DELETE ON fe_sessions TO fe_app;
GRANT SELECT, INSERT ON fe_ventures, fe_runs, fe_pitches, fe_investors, fe_stage_transitions, fe_invitations,
                        fe_pitch_sessions, fe_qa, fe_followups, fe_lessons, fe_audit_events TO fe_app;
GRANT UPDATE (stage) ON fe_investors TO fe_app;
GRANT UPDATE (revoked_at) ON fe_invitations TO fe_app;
GRANT UPDATE (status) ON fe_followups TO fe_app;
GRANT USAGE ON SEQUENCE fe_audit_events_seq_seq TO fe_app;

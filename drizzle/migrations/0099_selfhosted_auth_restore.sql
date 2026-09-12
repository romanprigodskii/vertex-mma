-- Restore the auth.users triggers after moving auth onto our own GoTrue.
--
-- Wave 34 (0055) put two triggers on auth.users: one mirrors a new auth user
-- into public.user_profile, the other cascades a deleted auth user into it.
-- Both lived in the hosted Supabase project's auth schema and were lost with
-- it — the migration that brought the database onto our own box carried the
-- public schema, and `auth` arrived empty. Everything else from 0055 survived:
-- the RLS policies, auth.uid(), and both trigger FUNCTIONS are still in place.
-- Only the triggers themselves need re-attaching, which could not happen until
-- GoTrue had recreated auth.users.
--
-- Idempotent: safe to re-run after any future auth migration.

-- Ownership: GoTrue connects as supabase_auth_admin and runs CREATE OR REPLACE
-- over its own schema on every start. Objects inherited from the hosted project
-- were owned by postgres, which made those replaces fail ("must be owner of
-- function uid") and crash-looped the service. Hand the whole schema over.
DO $$
DECLARE r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    RAISE EXCEPTION 'supabase_auth_admin is missing — create it before running this';
  END IF;
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO supabase_auth_admin', r.sig);
  END LOOP;
  FOR r IN
    SELECT c.oid::regclass AS rel
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth' AND c.relkind IN ('r','v','m','S')
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO supabase_auth_admin', r.rel);
  END LOOP;
END $$;

-- The trigger functions are SECURITY DEFINER and owned by postgres, so they
-- still insert into public.user_profile regardless of who signs up.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;
CREATE TRIGGER on_auth_user_deleted
  BEFORE DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_delete();

-- handle_new_user() runs as the definer but is invoked by supabase_auth_admin,
-- which needs to reach the public schema at all to fire it.
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;

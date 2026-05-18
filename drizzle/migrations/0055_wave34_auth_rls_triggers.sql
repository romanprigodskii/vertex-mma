-- Wave 34: core auth — Row Level Security policies on user-data tables +
-- trigger that mirrors auth.users INSERT into public.user_profile (with a
-- sanitised, unique username pulled from raw_user_meta_data) + a delete
-- trigger that cascades auth.users DELETE into user_profile (the rest of
-- the per-user tables fan out through ON DELETE CASCADE FKs already on
-- user_profile.id).
--
-- RLS strategy:
--   Server queries run via Drizzle on DATABASE_URL, typically the postgres
--   role which bypasses RLS — so server actions / route handlers retain
--   full access. Browser writes go through @supabase/ssr with the user's
--   JWT and are bound by the policies below. We enable RLS now so the
--   default for any future client-side write is locked down.
--
-- Not enabled here (deferred to their own waves):
--   market, bet, prediction_event, prediction_pick — these need their own
--   bookkeeping policies once Wave 4/5 lock down their write paths.
--
-- Re-runnable: every CREATE POLICY is wrapped in DROP POLICY IF EXISTS.
-- The trigger functions use CREATE OR REPLACE, and triggers are dropped
-- before re-creation.

-- ---------------------------------------------------------------------------
-- A) Enable RLS + policies
-- ---------------------------------------------------------------------------

ALTER TABLE user_profile      ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction       ENABLE ROW LEVEL SECURITY;
ALTER TABLE fight_card        ENABLE ROW LEVEL SECURITY;
ALTER TABLE fight_card_like   ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation        ENABLE ROW LEVEL SECURITY;

-- user_profile: public read, update only own row
DROP POLICY IF EXISTS "user_profile_select_all" ON user_profile;
CREATE POLICY "user_profile_select_all" ON user_profile
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "user_profile_update_own" ON user_profile;
CREATE POLICY "user_profile_update_own" ON user_profile
  FOR UPDATE USING (auth.uid() = auth_user_id);

-- transaction: read only own; writes go through server (service role)
DROP POLICY IF EXISTS "transaction_select_own" ON transaction;
CREATE POLICY "transaction_select_own" ON transaction
  FOR SELECT USING (
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );

-- fight_card: public read, owner writes
DROP POLICY IF EXISTS "fight_card_select_all" ON fight_card;
CREATE POLICY "fight_card_select_all" ON fight_card
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "fight_card_insert_own" ON fight_card;
CREATE POLICY "fight_card_insert_own" ON fight_card
  FOR INSERT WITH CHECK (
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "fight_card_update_own" ON fight_card;
CREATE POLICY "fight_card_update_own" ON fight_card
  FOR UPDATE USING (
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "fight_card_delete_own" ON fight_card;
CREATE POLICY "fight_card_delete_own" ON fight_card
  FOR DELETE USING (
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );

-- fight_card_like: public read, owner writes
DROP POLICY IF EXISTS "fight_card_like_select_all" ON fight_card_like;
CREATE POLICY "fight_card_like_select_all" ON fight_card_like
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "fight_card_like_insert_own" ON fight_card_like;
CREATE POLICY "fight_card_like_insert_own" ON fight_card_like
  FOR INSERT WITH CHECK (
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "fight_card_like_delete_own" ON fight_card_like;
CREATE POLICY "fight_card_like_delete_own" ON fight_card_like
  FOR DELETE USING (
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );

-- simulation: owner-only. user_id is nullable in the schema (ON DELETE
-- SET NULL keeps orphaned sims around for analytics); orphan rows are
-- effectively system-private — only the server (service role) can read
-- them. Browser clients never see NULL-owner rows.
DROP POLICY IF EXISTS "simulation_select_own" ON simulation;
CREATE POLICY "simulation_select_own" ON simulation
  FOR SELECT USING (
    user_id IS NOT NULL AND
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "simulation_insert_own" ON simulation;
CREATE POLICY "simulation_insert_own" ON simulation
  FOR INSERT WITH CHECK (
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "simulation_delete_own" ON simulation;
CREATE POLICY "simulation_delete_own" ON simulation
  FOR DELETE USING (
    user_id IN (SELECT id FROM user_profile WHERE auth_user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- B) Trigger: create user_profile on auth.users INSERT
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER lets the trigger insert into public.user_profile
-- regardless of who initiated the auth.users INSERT (typically the anon
-- role at sign-up). search_path pinned to public to keep the function
-- deterministic when invoked with a different default search path.
--
-- Username resolution:
--   1. Try raw_user_meta_data->>'username' (set by signUpAction).
--   2. Fallback to the email local-part.
--   3. Fallback to user_<first-8-of-uuid>.
-- Sanitised to [a-z0-9_], clipped to 3..30 chars, then made unique by
-- appending a counter (1..999). Final fallback uses the raw UUID without
-- dashes for the absurd case of 1000+ collisions.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  raw_username text;
  unique_username text;
  counter int := 0;
BEGIN
  raw_username := COALESCE(
    NEW.raw_user_meta_data->>'username',
    split_part(NEW.email, '@', 1),
    'user_' || substring(NEW.id::text, 1, 8)
  );

  raw_username := lower(regexp_replace(raw_username, '[^a-z0-9_]', '', 'gi'));
  IF length(raw_username) < 3 THEN
    raw_username := 'user_' || substring(NEW.id::text, 1, 8);
  END IF;
  IF length(raw_username) > 30 THEN
    raw_username := substring(raw_username, 1, 30);
  END IF;

  unique_username := raw_username;
  WHILE EXISTS (SELECT 1 FROM public.user_profile WHERE username = unique_username) LOOP
    counter := counter + 1;
    unique_username := substring(raw_username, 1, 26) || counter::text;
    IF counter > 999 THEN
      unique_username := 'user_' || replace(NEW.id::text, '-', '');
      EXIT;
    END IF;
  END LOOP;

  INSERT INTO public.user_profile (auth_user_id, username, display_name)
  VALUES (NEW.id, unique_username, raw_username);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------------------------------------------------------------------------
-- C) Trigger: cascade auth.users DELETE → user_profile DELETE
-- ---------------------------------------------------------------------------
--
-- Per-user dependent rows (transaction, simulation, fight_card,
-- fight_card_like, user_achievement) cascade through user_profile's FKs
-- on user_profile.id, so removing the profile row is sufficient.

CREATE OR REPLACE FUNCTION public.handle_user_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.user_profile WHERE auth_user_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;
CREATE TRIGGER on_auth_user_deleted
  BEFORE DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_delete();

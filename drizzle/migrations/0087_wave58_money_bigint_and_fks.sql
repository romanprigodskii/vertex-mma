-- Wave 58: pre-launch data-integrity hardening.
--
-- 1) Widen the coin-economy ACCUMULATORS from int4 to bigint. These grow
--    unbounded over the product's lifetime and would overflow int4's ~2.1B
--    ceiling. Per-bet amounts stay guarded by MAX_COINS_PER_BET, so only the
--    accumulators (+ the balance snapshot they feed) need widening.
-- 2) Widen the LMSR share quantities from real(float4) to double precision —
--    shares_bought is the payout basis via ROUND(shares_bought); float32's
--    ~0.06 granularity at large positions caused sub-coin drift.
-- 3) Add the previously-deferred referential FKs (ledger + comment tree) and a
--    hard FK from user_profile.auth_user_id to auth.users so deleting an auth
--    user structurally cascades the whole per-user graph (dashboard / admin API
--    / app), independent of the on_auth_user_deleted trigger.
--
-- Re-runnable: type ALTERs are no-ops once applied; every FK add is guarded by a
-- pg_constraint existence check; orphans are cleaned before each FK is added.
-- The whole file runs as one implicit transaction (atomic) via apply_wave58.ts.
--
-- NOTE (tracked follow-up): the PL/pgSQL settlement functions still declare
-- `v_new_balance int`. With balances now bigint, a single user balance above
-- ~2.1B would overflow that local at settlement. Far-future given the 10k grant
-- and 1M max bet; widen those locals to bigint the next time those functions are
-- regenerated. The stored columns are safe as of this migration.

-- ---------------------------------------------------------------------------
-- 1) Coin accumulators -> bigint
-- ---------------------------------------------------------------------------
-- The user_profile_balance_non_negative CHECK and the balance/index objects on
-- these columns survive the widening (Postgres re-derives them in place).
ALTER TABLE user_profile
  ALTER COLUMN balance_coins      TYPE bigint,
  ALTER COLUMN total_coins_earned TYPE bigint,
  ALTER COLUMN total_coins_lost   TYPE bigint,
  ALTER COLUMN bet_count          TYPE bigint;

ALTER TABLE transaction
  ALTER COLUMN amount        TYPE bigint,
  ALTER COLUMN balance_after TYPE bigint;

ALTER TABLE market
  ALTER COLUMN total_volume TYPE bigint;

-- ---------------------------------------------------------------------------
-- 2) LMSR share quantities -> double precision
-- ---------------------------------------------------------------------------
ALTER TABLE bet
  ALTER COLUMN shares_bought TYPE double precision;

ALTER TABLE market_outcome
  ALTER COLUMN current_shares TYPE double precision;

-- ---------------------------------------------------------------------------
-- 3a) transaction.related_bet_id -> bet.id (SET NULL — ledger is immutable)
-- ---------------------------------------------------------------------------
UPDATE transaction t
  SET related_bet_id = NULL
  WHERE related_bet_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM bet b WHERE b.id = t.related_bet_id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transaction_related_bet_id_bet_id_fk'
  ) THEN
    ALTER TABLE transaction
      ADD CONSTRAINT transaction_related_bet_id_bet_id_fk
      FOREIGN KEY (related_bet_id) REFERENCES bet(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3b) transaction.related_achievement_id -> achievement.id (SET NULL)
-- ---------------------------------------------------------------------------
UPDATE transaction t
  SET related_achievement_id = NULL
  WHERE related_achievement_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM achievement a WHERE a.id = t.related_achievement_id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transaction_related_achievement_id_achievement_id_fk'
  ) THEN
    ALTER TABLE transaction
      ADD CONSTRAINT transaction_related_achievement_id_achievement_id_fk
      FOREIGN KEY (related_achievement_id) REFERENCES achievement(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3c) news_comment.parent_id -> news_comment.id (CASCADE, self-ref)
-- ---------------------------------------------------------------------------
UPDATE news_comment c
  SET parent_id = NULL
  WHERE parent_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM news_comment p WHERE p.id = c.parent_id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'news_comment_parent_id_news_comment_id_fk'
  ) THEN
    ALTER TABLE news_comment
      ADD CONSTRAINT news_comment_parent_id_news_comment_id_fk
      FOREIGN KEY (parent_id) REFERENCES news_comment(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3d) user_profile.auth_user_id -> auth.users.id (CASCADE)
-- ---------------------------------------------------------------------------
-- Non-fatal: if this role lacks REFERENCES on auth.users (cross-schema), the
-- whole migration must still commit — the on_auth_user_deleted trigger (3e)
-- remains the orphan guard. Pre-existing orphans (auth user already gone) are
-- removed first; their per-user graph fans out through user_profile.id's
-- ON DELETE CASCADE FKs.
DO $$ BEGIN
  DELETE FROM public.user_profile up
    WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = up.auth_user_id);

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_profile_auth_user_id_users_id_fk'
  ) THEN
    ALTER TABLE public.user_profile
      ADD CONSTRAINT user_profile_auth_user_id_users_id_fk
      FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Wave58: auth.users FK not added (%). on_auth_user_deleted trigger remains the orphan guard.', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- 3e) Re-assert the auth.users DELETE -> user_profile trigger (belt &
--     suspenders alongside the FK; idempotent — proves it is applied in prod).
-- ---------------------------------------------------------------------------
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

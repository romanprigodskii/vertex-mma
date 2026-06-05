-- Wave 56: avatars are now written exclusively server-side via the
-- service-role client (see uploadAvatarAction in
-- src/app/[locale]/settings/actions.ts). The storage path is derived from
-- the authenticated session, not from client input.
--
-- The browser no longer writes to storage.objects at all, so the per-user
-- write policies added in Wave 35 (0056) are dead grants. Drop them: with
-- RLS still enabled and no write policy, anon/authenticated JWTs are
-- default-denied for writes, and the only writer is the service role
-- (which bypasses RLS). This removes the client write path entirely — a
-- cross-user avatar overwrite no longer depends on a path-matching policy
-- being present and correct.
--
-- Public read (avatars_select_all) STAYS: avatar URLs are public.
--
-- Re-runnable: DROP POLICY IF EXISTS.

DROP POLICY IF EXISTS "avatars_insert_own" ON storage.objects;
DROP POLICY IF EXISTS "avatars_update_own" ON storage.objects;
DROP POLICY IF EXISTS "avatars_delete_own" ON storage.objects;

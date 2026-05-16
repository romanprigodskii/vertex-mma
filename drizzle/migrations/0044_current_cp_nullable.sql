-- Wave 13.1: make fighter.current_cp nullable.
--
-- current_cp was added in Wave 12 as NOT NULL DEFAULT 0. After 13.1
-- compute_current_cp.ts only populates the column for active fighters
-- (roster_status='active'); retired/released fighters get NULL so the
-- semantics are clear in SQL audits ("current_cp = NULL → not in the
-- current rating pool"). The view's COALESCE(f.current_cp, 0)::float
-- handles NULL safely for the rare edge-case where a non-active fighter
-- still passes the view's is_active OR-condition (last fight within
-- 24mo); they lose CP contribution to raw_current but their other
-- components still apply.
--
-- DROP DEFAULT alongside DROP NOT NULL so a future re-run of
-- compute_current_cp.ts can leave inactive fighters at NULL after the
-- initial reset (UPDATE ... SET current_cp = NULL) — the column default
-- of 0 would otherwise re-seed them at the wrong value.

ALTER TABLE fighter ALTER COLUMN current_cp DROP NOT NULL;
ALTER TABLE fighter ALTER COLUMN current_cp DROP DEFAULT;

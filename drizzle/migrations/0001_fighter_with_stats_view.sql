-- Run manually in Supabase SQL Editor. Drizzle push does not manage views.
-- Provides a denormalized read-only surface for Wave 3A (fighter catalog).

CREATE OR REPLACE VIEW fighter_with_stats AS
SELECT
  f.*,
  fsa.wins_total,
  fsa.losses_total,
  fsa.draws_total,
  fsa.no_contests,
  fsa.wins_ko,
  fsa.wins_sub,
  fsa.wins_dec,
  fsa.losses_ko,
  fsa.losses_sub,
  fsa.losses_dec,
  fsa.slpm,
  fsa.str_acc,
  fsa.sapm,
  fsa.str_def,
  fsa.td_avg,
  fsa.td_acc,
  fsa.td_def,
  fsa.sub_avg,
  fsa.overall_rating,
  fsa.striking_rating,
  fsa.grappling_rating,
  fsa.cardio_rating,
  fsa.chin_rating,
  fsa.power_rating,
  fsa.iq_rating,
  (
    SELECT COUNT(*)
    FROM bout
    WHERE fighter_a_id = f.id OR fighter_b_id = f.id
  ) AS bout_count
FROM fighter f
LEFT JOIN fighter_stats_aggregate fsa ON fsa.fighter_id = f.id;

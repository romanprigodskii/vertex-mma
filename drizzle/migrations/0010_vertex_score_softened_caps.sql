-- Wave 3.5 step 3.6: soften component caps + champion bonus.
--
-- Why: after step 3.5 only Islam crossed 80 and Elite tier had 1 fighter.
-- The component normalizers (wins/30, SLpM/7, str_acc/0.6, etc.) required
-- numbers that virtually no real fighter hits across all sub-stats. This
-- migration relaxes the divisors so a *typical* top performer reaches
-- ~90-95 on each component, and applies a small post-cap bonus to current
-- champions (+4) and dominant former champions (+3) so genuine all-time
-- greats land in Elite (80+) rather than mid-Contender.
--
-- Cap changes:
--   Win Quality        wins / 30  → wins / 25
--   Striking Excellence
--     SLpM             / 7.0      → / 5.5
--     Str Acc          / 0.6      → / 0.55
--     Str Def          / 0.7      → / 0.65
--   Grappling Excellence
--     TD avg           / 5.0      → / 4.0
--     TD def           / 0.85     → / 0.80
--     Sub avg          / 3.0      → / 2.5
--
-- Bonuses (applied post-cap, before final clamp to [0, 100]):
--   current champion (championship_pedigree = 100)    +4
--   dominant former champion (is_dominant_champion)   +3
--   else                                                0

DROP VIEW IF EXISTS fighter_vertex_score CASCADE;

CREATE VIEW fighter_vertex_score AS
WITH
ufc_record AS (
  SELECT
    f.id AS fighter_id,
    COUNT(*) FILTER (WHERE b.status = 'completed') AS ufc_bouts,
    COUNT(*) FILTER (WHERE b.winner_id = f.id AND b.status = 'completed') AS ufc_wins,
    COUNT(*) FILTER (
      WHERE b.status = 'completed'
        AND b.winner_id IS NOT NULL
        AND b.winner_id <> f.id
    ) AS ufc_losses,
    MAX(e.date) FILTER (WHERE b.status = 'completed') AS last_fight_date
  FROM fighter f
  LEFT JOIN bout b
    ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
  LEFT JOIN event e ON e.id = b.event_id
  GROUP BY f.id
),
method_counts AS (
  SELECT
    f.id AS fighter_id,
    COUNT(*) FILTER (
      WHERE b.winner_id = f.id
        AND b.status = 'completed'
        AND (
          LOWER(b.method::text) LIKE 'ko%'
          OR LOWER(b.method::text) LIKE 'tko%'
          OR (b.method IS NULL AND COALESCE(brs_win.knockdowns, 0) > 0)
        )
    ) AS ufc_wins_ko,
    COUNT(*) FILTER (
      WHERE b.winner_id = f.id
        AND b.status = 'completed'
        AND (
          LOWER(b.method::text) LIKE 'sub%'
          OR (
            b.method IS NULL
            AND COALESCE(brs_win.knockdowns, 0) = 0
            AND COALESCE(brs_win.sub_attempts, 0) > 0
          )
        )
    ) AS ufc_wins_sub,
    COUNT(*) FILTER (
      WHERE b.winner_id = f.id
        AND b.status = 'completed'
        AND LOWER(b.method::text) LIKE '%dec%'
    ) AS ufc_wins_dec
  FROM fighter f
  LEFT JOIN bout b
    ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
  LEFT JOIN bout_round_stats brs_win
    ON brs_win.bout_id = b.id
   AND brs_win.fighter_id = b.winner_id
   AND brs_win.round = b.round_finished
  GROUP BY f.id
),
ranked_bouts AS (
  SELECT
    f.id AS f_id,
    b.id AS bout_id,
    b.winner_id,
    e.date AS event_date,
    ROW_NUMBER() OVER (
      PARTITION BY f.id
      ORDER BY e.date DESC, b.id DESC
    ) AS rn_desc
  FROM fighter f
  JOIN bout b ON (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
  JOIN event e ON e.id = b.event_id
  WHERE b.status = 'completed'
),
recent_losses AS (
  SELECT
    f_id AS fighter_id,
    COUNT(*) FILTER (
      WHERE rn_desc <= 3
        AND winner_id IS NOT NULL
        AND winner_id <> f_id
    )::int AS losses_last_3,
    COUNT(*) FILTER (
      WHERE rn_desc <= 5
        AND winner_id IS NOT NULL
        AND winner_id <> f_id
    )::int AS losses_last_5,
    COUNT(*) FILTER (
      WHERE event_date > NOW() - INTERVAL '24 months'
        AND winner_id IS NOT NULL
        AND winner_id <> f_id
    )::int AS losses_24mo
  FROM ranked_bouts
  GROUP BY f_id
),
components AS (
  SELECT
    f.id,
    f.slug,
    f.is_dominant_champion,
    COALESCE(ur.ufc_bouts, 0) AS ufc_bouts,
    COALESCE(ur.ufc_wins, 0) AS ufc_wins,
    COALESCE(ur.ufc_losses, 0) AS ufc_losses,
    ur.last_fight_date,

    (ur.last_fight_date IS NOT NULL
     AND ur.last_fight_date > NOW() - INTERVAL '36 months') AS is_active,

    COALESCE(mc.ufc_wins_ko, 0) AS ufc_wins_ko,
    COALESCE(mc.ufc_wins_sub, 0) AS ufc_wins_sub,
    COALESCE(mc.ufc_wins_dec, 0) AS ufc_wins_dec,
    COALESCE(rl.losses_last_3, 0) AS losses_last_3,
    COALESCE(rl.losses_last_5, 0) AS losses_last_5,
    COALESCE(rl.losses_24mo, 0) AS losses_24mo,

    -- Win Quality — wins / 25 (was / 30); win rate same.
    LEAST(100, GREATEST(0,
      (
        (LEAST(COALESCE(ur.ufc_wins, 0), 25)::float / 25.0 * 60.0)
        + (
          COALESCE(
            COALESCE(ur.ufc_wins, 0)::float
              / NULLIF(COALESCE(ur.ufc_wins, 0) + COALESCE(ur.ufc_losses, 0), 0),
            0.5
          ) * 40.0
        )
      ) * (LEAST(COALESCE(ur.ufc_bouts, 0), 15)::float / 15.0)
    )) AS win_quality,

    COALESCE(f.championship_pedigree, 0)::float AS championship_pedigree,

    CASE
      WHEN ur.last_fight_date IS NULL THEN 0
      WHEN ur.last_fight_date > NOW() - INTERVAL '12 months' THEN 100
      WHEN ur.last_fight_date > NOW() - INTERVAL '24 months' THEN 70
      WHEN ur.last_fight_date > NOW() - INTERVAL '36 months' THEN 40
      ELSE 0
    END::float AS activity,

    -- Striking — divisors lowered so a top striker reaches ~90-95.
    (LEAST(100, GREATEST(0,
      LEAST(COALESCE(fsa.slpm, 0)::float / 5.5 * 35.0, 35.0)
      + LEAST(COALESCE(fsa.str_acc, 0)::float / 0.55 * 25.0, 25.0)
      + LEAST(COALESCE(fsa.str_def, 0)::float / 0.65 * 25.0, 25.0)
      + LEAST(
          COALESCE(
            COALESCE(mc.ufc_wins_ko, 0)::float
              / NULLIF(COALESCE(ur.ufc_wins, 0), 0),
            0
          ) * 15.0,
          15.0
        )
    )) * (LEAST(COALESCE(ur.ufc_bouts, 0), 15)::float / 15.0)) AS striking_excellence,

    -- Grappling — divisors lowered to match.
    (LEAST(100, GREATEST(0,
      LEAST(COALESCE(fsa.td_avg, 0)::float / 4.0 * 25.0, 25.0)
      + LEAST(COALESCE(fsa.td_def, 0)::float / 0.80 * 30.0, 30.0)
      + LEAST(COALESCE(fsa.sub_avg, 0)::float / 2.5 * 25.0, 25.0)
      + LEAST(
          COALESCE(
            COALESCE(mc.ufc_wins_sub, 0)::float
              / NULLIF(COALESCE(ur.ufc_wins, 0), 0),
            0
          ) * 20.0,
          20.0
        )
    )) * (LEAST(COALESCE(ur.ufc_bouts, 0), 15)::float / 15.0)) AS grappling_excellence,

    COALESCE(f.peak_score, 0)::float AS peak_score,

    LEAST(100,
      COALESCE(rl.losses_last_3, 0) * 25
      + COALESCE(rl.losses_last_5, 0) * 12
      + COALESCE(rl.losses_24mo, 0) * 6
    )::float AS recent_loss_penalty,

    LEAST(100, COALESCE(ur.ufc_losses, 0) * 4)::float AS total_loss_penalty,

    CASE
      WHEN COALESCE(ur.ufc_bouts, 0) < 5 THEN 0::float
      ELSE LEAST(COALESCE(ur.ufc_bouts, 0), 15)::float / 15.0
    END AS peak_tenure_factor,

    -- Champion bonus: post-cap +4 for active champions, +3 for dominant
    -- former champions (double champions OR >= 2 years cumulative reign),
    -- else 0. Applied to BOTH current and all-time scores.
    CASE
      WHEN COALESCE(f.championship_pedigree, 0) = 100 THEN 4
      WHEN f.is_dominant_champion THEN 3
      ELSE 0
    END::float AS champion_bonus
  FROM fighter f
  LEFT JOIN ufc_record ur ON ur.fighter_id = f.id
  LEFT JOIN method_counts mc ON mc.fighter_id = f.id
  LEFT JOIN recent_losses rl ON rl.fighter_id = f.id
  LEFT JOIN fighter_stats_aggregate fsa ON fsa.fighter_id = f.id
)
SELECT
  id,
  slug,
  ufc_bouts,
  ufc_wins,
  ufc_losses,
  last_fight_date,
  is_active,
  is_dominant_champion,
  ufc_wins_ko,
  ufc_wins_sub,
  ufc_wins_dec,
  losses_last_3,
  losses_last_5,
  losses_24mo,
  win_quality,
  championship_pedigree,
  activity,
  striking_excellence,
  grappling_excellence,
  peak_score,
  peak_tenure_factor,
  recent_loss_penalty,
  total_loss_penalty,
  champion_bonus,

  CASE
    WHEN is_active AND ufc_bouts >= 3 THEN
      GREATEST(0, LEAST(100, ROUND(
        win_quality * 0.35
        + championship_pedigree * 0.25
        + activity * 0.15
        + striking_excellence * 0.12
        + grappling_excellence * 0.13
        - recent_loss_penalty * 0.20
        + champion_bonus
      )))::integer
    ELSE NULL
  END AS vertex_score,

  CASE
    WHEN ufc_bouts >= 3 THEN
      GREATEST(0, LEAST(100, ROUND(
        win_quality * (0.32 + 0.18 * (1.0 - peak_tenure_factor))
        + championship_pedigree * 0.25
        + striking_excellence * 0.12
        + grappling_excellence * 0.13
        + peak_score * (0.18 * peak_tenure_factor)
        - total_loss_penalty * 0.15
        + champion_bonus
      )))::integer
    ELSE NULL
  END AS vertex_score_all_time
FROM components;

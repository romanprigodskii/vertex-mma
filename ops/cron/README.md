# Vertex MMA — data pipeline cron

These are the cron wrappers that run on the production VPS
(`/opt/vertex-cron/*.sh`, root crontab). They are committed here so the
pipeline lives in version control; the VPS copies are the source of truth
at runtime (the checkout's `git pull` is currently best-effort — see below).

## Schedule (`crontab.txt`)

| When | Script | Does |
|---|---|---|
| hourly | `news-refresh.sh` | RSS → extract → classify (Haiku) → rephrase → translate; auto-creates provisional events/bouts |
| every 6h | `scrape-refresh.sh` | re-list events + recent bouts (results) + bestfightodds + `fighter_with_stats` matview |
| every 6h at :20 | `verify-cards.sh` | diff every upcoming card against the live UFCStats card; read-only, logs `CARD DRIFT` on disagreement |
| daily 04:00 | `sherdog-refresh.sh` | Sherdog pre-UFC fight histories (step 17, incremental: new fighters + upcoming-bout retries/re-syncs) → `fighter_sherdog_bout`, feeds the model's pre-UFC features before predict at 05:15 |
| **daily 04:30** | `scrape-stats.sh` | **`enrich-bouts` (per-round stats) + `scorecards` + full recompute** |
| daily 05:15 | `predict-refresh.sh` | score upcoming bouts → `bout_simulation`/`_features`/`_rounds` (winner + Monte-Carlo props) so the sportsbook + "how" panel don't go stale. Committed model (no retrain). Needs `.env.local` at the repo root for `DATABASE_URL`. |
| weekly Sun 05:30 | `scrape-full.sh` | `run_all.py --phase all` (A-Z incl. enrich-fighters) + full recompute |
| weekly Sun 07:00 | `retrain-refresh.sh` | retrain the model on the latest data (refit-on-all served weights) → commit + push artifacts **if** the weights changed. Deterministic, so no-op when no new fights. Auto-commits to main; needs deploy-key push access + `.env.local`. |
| daily 03:30 | `rankings-refresh.sh` | live `ufc.com/rankings` → parse → import `ranking_snapshot` (before the daily recompute) |

The daily `scrape-stats.sh` is the job whose absence let per-round stats,
scorecards and score-history silently go ~1 month stale (the old cron only
ran the light `refresh`/`quick` phases — never `enrich-bouts`/`scorecards`).

`verify-cards.sh` is the same lesson from the other direction. Every job here
reports whether it *ran*; none reported whether the result was *right*, so
three fights that were never booked sat on live cards for a week while the
scrape logs stayed green. It re-reads the source and diffs, which is the only
way that class of defect surfaces without a user noticing first:

```bash
grep "CARD DRIFT" /var/log/vertex-cron.log      # any disagreement, ever
grep -A3 "verify-cards start" /var/log/vertex-cron.log | tail -20
```

`CARD DRIFT` means a bout is on one side and not the other — the EXTRA /
MISSING lines directly above it name the fights. EXTRA is usually a
provisional (news-created) row UFCStats never adopted; MISSING is a scrape
that under-read a card. Neither is self-healing: investigate, then either
`scripts/scraper/scripts/purge_phantom_bookings.py --apply` (for a phantom) or
a targeted re-scrape (for a miss).

## Recompute chain (`recompute.sh`)

After any scrape, derived fighter data must be rebuilt in dependency order.
12 idempotent scripts (each resets its own target first), ~5 min:

```
derive_title_fights → compute_opponent_quality → compute_current_division
→ compute_championship_pedigree → compute_current_cp → compute_peak_scores
→ compute_era_dominance → compute_radar_aggregates → compute_score_history
→ materialize_vertex_score → materialize_divisional_score
→ materialize_fighter_with_stats
```

`compute_score_history` and `materialize_divisional_score` TRUNCATE+repopulate
(brief empty window — runs at 04:30 on purpose).

## Conventions

- All ufcstats scrapers share `flock /var/lock/vertex-scrape.lock` → never
  overlap. News has its own `/var/lock/vertex-news.lock`, rankings
  `/var/lock/vertex-rankings.lock` (fd 7), sherdog
  `/var/lock/vertex-sherdog.lock` (fd 6 — separate on purpose: it doesn't
  touch ufcstats.com, and holding the shared lock past 04:30 would make
  scrape-stats silently skip its run).
- `git_sync()` is **best-effort**: a fetch failure leaves the checkout pinned
  and never aborts the job (prints `git: sync skipped — staying on pinned …`).
- Logs: `/var/log/vertex-cron.log` (scrape+recompute), `/var/log/vertex-news.log`.
- Secrets: the checkout's root `.env.local` (untracked).

## Install / update on the VPS

```bash
# from a machine with the deploy key:
scp ops/cron/*.sh ops/cron/crontab.txt root@<vps>:/opt/vertex-cron/
ssh root@<vps> 'chmod +x /opt/vertex-cron/*.sh && crontab /opt/vertex-cron/crontab.txt'
```

> Note: the VPS checkout's git remote is HTTPS without credentials, so
> `git fetch` there fails and the checkout is frozen. Either keep deploying
> the wrappers via `scp` (above), or add a GitHub **deploy key** and switch
> the remote to SSH so `git_sync()` resumes pulling `main`.

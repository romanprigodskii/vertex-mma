# Vertex MMA — Vision (Pilot A: the feasibility gate)

Pose estimation over fight footage. The long-term question is whether a
skeleton stream sees something the closing line doesn't. This directory
does **not** answer that question. It answers the one that comes first,
and that almost nobody asks before spending months on video:

> Can pose extraction recover quantities we already know are true?

If the pipeline cannot reproduce "how much of this fight happened on the
ground" — a number UFCStats already gives us for all 8 847 completed
bouts — then every downstream feature it produces is noise wearing a
skeleton, and the honest move is to stop here.

## Why this gate, and not a betting backtest

The model already carries 185 features over 6 443 bouts. Pose would add
hundreds more candidates against the same fixed `n` and the same binary
label. `lab_graded_style.json` is what that looks like when it goes
badly: 20 style hypotheses, 0 survivors on the rolling basis. The
instrument's MDE is 0.0036 — small effects are invisible to it by
construction, so a feature family has to be *large* to matter, and a
feature family that cannot reproduce ground time is not large.

So the gate is deliberately not "does it make money". It is
"does it measure anything at all", tested against ground truth we did
not have to guess at.

## Verdict — PASS (2026-08-24)

Ran on 39 fights; 38 cleared the coverage floor.

| correlation | rho | p | |
|---|---|---|---|
| **frac_ground ~ ground_strike_share** (primary) | **+0.636** | 0.0001 | **pass** |
| frac_ground ~ control_share | +0.848 | 0.0000 | pass |
| frac_distance ~ distance_strike_share | +0.290 | 0.077 | weak |
| mean_separation ~ distance_strike_share | −0.242 | 0.145 | fail |

Pose recovers where a fight happened on the vertical axis, and recovers
it well — the agreement with control time is stronger than with the
strike split, which makes sense, since control time is the thing
"both bodies horizontal" most directly is.

It does NOT recover distance vs clinch. The separation term even comes
out with the wrong sign. A broadcast camera foreshortens: two fighters
at range with one behind the other read as adjacent, and no threshold on
apparent separation fixes a projection problem. Build on verticality;
do not build on distance without depth.

What this licenses is narrow. The gate asked whether pose measures
anything real, and the answer is yes. It says nothing about whether pose
sees anything the closing line doesn't — that is a different question
against a fixed n, an MDE of 0.0036, and a market that already contains
everyone's film study.

## Held-out verdict — PASS (2026-08-24)

35 fights the pipeline had never seen, extracted on a rented 4090, zero
fetch or pose failures. Both feature rules scored on the SAME fights,
neither tuned on them:

| rule | coverage | rho ~ ground | rho ~ control | rho ~ distance |
|---|---|---|---|---|
| pre-fix | 0.935 | +0.700 | +0.774 | +0.291 |
| **current** | **0.966** | **+0.737** | **+0.840** | **+0.602** |

Read it carefully. The jump from the pilot's +0.653 to +0.737 is NOT the
fix getting better — the old rule also scores higher here (+0.700), so
the holdout is simply an easier draw. The honest effect of the occlusion
fix is the same-set comparison: **+0.037 on the primary, which is
modest, and +0.311 on distance, which is not.**

## Tracking is not the answer to identity

A decline detector needs to know WHICH fighter a skeleton belongs to.
Frame-to-frame tracking was the obvious route and it does not work, at
any sampling rate worth paying for:

| fps | distinct ids | top-2 persistence |
|---|---|---|
| 5 | 51 | 37% |
| 10 | 62 | 28% |
| 15 | 62 | 41% |

Tripling the frame rate — and therefore tripling a 400 h corpus run —
buys nothing. Identity needs an appearance cue (shorts colour, corner
assignment), not more frames.

## The corpus

`bout_video` already maps 112 YouTube uploads to bouts. Two are
mislabelled clips — a 201 s video on a 1 500 s fight (`Arlovski vs
Sylvia`) and a 258 s one on `Holloway vs Gaethje`, which is the finish,
not the fight. `manifest.py` drops any row whose runtime is shorter than
the bout it claims to be, leaving **110 usable fights**, every one of
them carrying `bout_round_stats`.

That filter is the same lesson as the odds backfill: a match on names
alone is not a match. Here the arithmetic of round-and-clock is the
independent check, and it costs nothing to run.

## What is deliberately not modelled yet

- **Fighter identity.** Assigning skeleton → fighter A/B is the hard
  sub-problem (similar builds, occlusion, shorts colour under stage
  lighting). The gate is built entirely from *identity-free* features —
  the geometric relationship between the two bodies — so identity stays
  off the critical path until the gate is passed.
- **Replays and slow motion.** A UFC upload is not pure fight footage.
  Replays re-show the same exchange, so any absolute time measured off
  the video is inflated. The gate therefore compares *fractions*, never
  seconds, and shot-cut/optical-flow filtering is the first refinement
  if the correlation is real but weak.
- **The ground game itself.** Two interpenetrating bodies is where
  keypoint assignment fails hardest. That is the point: it is measured
  here rather than assumed, because it is exactly where MMA's outcome
  variance lives.

## Measured throughput

Benchmarked on one fight (6 374 frames, M3, yolo11m-pose, MPS):

| | |
|---|---|
| Inference | **17.2 frames/s** — 6.2 min per fight |
| Frames carrying a detection | **99 %** (6 287 / 6 374) |
| Persons per frame | ~3.6 — so the referee and cornermen are in there too |
| Skeletons | 8.7 MB per fight |

Which prices the thing that actually matters. The 40-fight pilot is
~4 h. Every completed bout since 2010 is 7 582 fights, 24.9 M frames at
5 fps, and therefore **~400 h — seventeen days of the laptop doing
nothing else**, plus 66 GB of skeletons. That is the number that makes
the gate worth running first, and the number a rented GPU would cut to
under two days.

## Install

```bash
cd scripts/vision
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Separate venv on purpose — `scripts/simulation/venv` is pinned for
reproducibility and must not acquire a torch/ultralytics tree.

`.env.local` at the project root supplies `DATABASE_URL`, reused
verbatim. Needs `ffmpeg` and `yt-dlp` on PATH (both via Homebrew).

## Run

```bash
source venv/bin/activate
python scripts/build_manifest.py               # bout_video -> artifacts/manifest.json
python scripts/extract_pose.py --limit 40      # video -> data/skeletons/*.parquet
python scripts/run_validation.py               # the gate -> artifacts/validation.json
```

Video is cached under `data/video/` and is safe to delete — skeletons
are the durable artifact and are ~2 MB per fight against ~300 MB of
source. Both directories are gitignored; `artifacts/` is committed.

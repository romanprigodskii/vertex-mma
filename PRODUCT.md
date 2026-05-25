# Vertex MMA — Design Context

A UFC / MMA stats + community platform combining deep fighter analytics, virtual-coin betting markets, a Haiku-rephrased news feed, and community-driven cards, rankings, and predictions.

## Audience

**Primary: hardcore MMA stats nerds.**

The reader who will spend ten minutes on a fighter profile reading the round-by-round breakdown, comparing peak Vertex scores, second-guessing the formula, and digging through fight history. They expect:

- Methodology to be visible and defendable — Peak Vertex panel, score breakdowns, divisional vs. all-time.
- Numbers everywhere: tabular alignment, clear units, no UX flourish that obscures the data.
- Edge cases handled (retired fighters, interim champions, no contests, weight-class moves) — they will notice when they are not.

Casual fans, bettors, and collectors all use the site; **design decisions resolve in favour of the stats user when in conflict.**

## Use cases (all primary, all first-class surfaces)

1. **Fighter stats deep-dive** — the roster catalog, fighter profile, Peak Vertex panel, striking heatmap, career timeline, score comparisons.
2. **Betting markets + picks** — open markets, per-fight markets pages, sportsbook consensus, bet form, leaderboard.
3. **MMA news feed** — hourly auto-ingest, Haiku rephrase, classification badges, fighter chips, on-site article pages with source links.
4. **Simulator + community layer** — fight simulator, prediction events, build-your-own fight cards, custom rankings.

## Brand personality

**Gamified fan platform at its core — coins, leaderboard rivalry, an animated career timeline — but governed by data-publication discipline.**

Dark and current, yet restrained: **one confident accent, not tier-gradient soup.** No holographic cards, no glow stacks, no decorative gradients-for-the-sake-of-it. Real typographic hierarchy does the work, and dense, legible tables carry the leaderboard and fighter stats — numbers are the product, so they get a proper type scale and alignment, never buried under effects.

Motion is **purposeful and fast** (sub-300 ms, ease-out), never ambient.

**The feel: a high-end fan app a serious MMA nerd would respect — not a betting parlour, not a casino, not an AI-template dashboard.**

## Visual principles

### Colour
- **Dark canvas only.** No light theme, ever.
- **One confident accent: amber** `oklch(0.78 0.15 70)`. Reserved for things that genuinely deserve attention — primary actions, active states, the "today" timeline marker, the champion crown. Nothing else lifts off the page.
- **Tier identity is a chip or a 1-px edge, never a full background gradient.** A single-letter mark or a thin coloured border is enough to signal Apex / Elite / Established / Roster.
- **Result colours used sparingly** — win green, loss red, draw / no-contest muted — for streak labels, result pills, and fight-history dots.
- **Heatmap intensity is opacity on a single hue** (gold for landed, red for absorbed). Lightness ramps produce muddy mid-tones.

### Type (does the heavy lifting)
- **Display** — bold condensed sans (Anton-class). Hero names, page titles, big numbers. Uppercase, tight tracking. **Hierarchy comes from size and weight, not colour.**
- **Sans** — body copy and descriptions. Measured line length, never edge-to-edge.
- **Mono / tabular** — every number that compares: records, scores, percentages, dates. `font-variant-numeric: tabular-nums` always on.
- **Size scale:** hero · h1 · h2 · h3 · base · small · meta. Pick a step; never ad-hoc px.

### Density and tables
- **Numbers are the product.** Leaderboard, fighter stats, score breakdowns, scorecards — all live in proper tables with right-aligned numeric columns, fixed widths where it helps readability, and unobtrusive dividers (no zebra striping).
- **Comparison rows beat hero blocks** when the question is "how does X stack up against Y?".
- The instinct to make data feel "rich" with cards / gradients is wrong here. Density and alignment make data feel rigorous.

### Layout
- **Container** — centred, capped at **1800 px** on the widest tier. Edge-to-edge was explicitly rejected.
- **Grid density** — index pages add a column at the `2xl` breakpoint so wide displays fill with more content, not stretched cards.
- **Single-column reading tiers** (`md`, `sm`) keep their narrower caps; full-width single column reads poorly on large screens.

### Motion
- **Sub-300 ms, ease-out.** Fast and decisive — a fade, a slide, a number tick, a tier-chip flick.
- **Never ambient.** No looping gradients, no idle pulse, no decorative drift, no parallax-for-vibes.
- The career timeline is the one place motion carries real informational weight, and even there it is snap-fast, drag-driven, no inertia bounce.

## Voice and copy

- **Direct.** "No live odds for this fight yet." Not "We're currently working on…".
- **Mono for verdict.** `vs current`, `W16 streak`, `Last: W (U-DEC)` — these are tabular, not prose.
- **No filler.** A 50-word honest summary beats a padded 250-word one (the news rephraser prompt enforces this on the AI side).
- **English ships in the UI.** Internal notes and prompts to the AI assistant may be Russian.

## Anti-patterns

- **No holographic cards, foil overlays, or tilt effects.**
- **No tier-gradient washes** on card or row backgrounds. A chip or a 1-px edge is the upper bound.
- **No glow stacks or decorative shadows.** One subtle elevation per surface, max.
- **No system odds** — never render LMSR-default uniform-price markets. Wait for real odds or trades.
- **No all-time-as-fallback-for-current.** A null current counts as 0 for the peak-vs-current delta, otherwise we misrepresent how far an inactive fighter has dropped.
- **No edge-to-edge layout.** Content caps at 1800 px on the widest tier.
- **No padding to a word count.** A short honest line beats invented specifics.
- **No champion claims from memory.** Championship status reads from `src/lib/championship-history.ts`.
- **No light theme.**
- **No ambient motion.** Loops, idle pulses, decorative drift — all out.

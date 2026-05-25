# Tech debt

Tracked follow-ups that aren't blockers for the current wave but should
not be silently lost.

---

## Rebrand — token cleanup (post-migration phase)

The Sodium-night rebrand introduces new role tokens (`fg`, `edge`,
`accent`, `profit`, `loss`, `surface-*`) alongside the legacy tokens
(`foreground`, `border`, `primary`, `success`, `danger`, `streak-*`,
`background-*`). They coexist on purpose so surfaces can migrate one at
a time without a flag-day. Once every surface is on the new tokens,
this cleanup pass becomes possible.

### Owner: whoever ships the last surface migration

### 1. Delete legacy colour tokens from `@theme` (in `src/app/globals.css`)

- `--color-background-base`, `--color-background-elevated`, `--color-background-overlay`
- `--color-foreground`, `--color-foreground-muted`, `--color-foreground-subtle`
- `--color-primary`, `--color-primary-hover`, `--color-primary-foreground`
- `--color-red-accent`, `--color-red-accent-hover`
- `--color-gold`, `--color-gold-foreground`
- `--color-success`, `--color-danger`, `--color-danger-foreground`, `--color-warning`, `--color-info`
- `--color-streak-win`, `--color-streak-loss`
- `--color-border`, `--color-border-strong`

Fighter-tier tokens (`--color-tier-apex/-elite/-established/-roster`) and
champion tokens (`--color-champion-active/-dominant`) stay — they were
added in the fighter-card migration as part of the rebrand, not legacy.

Account-tier tokens (`--color-account-tier-bronze/-silver/-gold/-diamond/-champion`)
have their own cleanup item below — see the "Account-tier rename" section.

`--color-submission` and `--color-knockdown` (round-by-round bars) should
be reviewed against the Sodium palette during cleanup; they may need
tonal adjustment but don't have direct replacements yet.

### 2. Rename transitional tokens to their permanent names

The short `fg` / `edge` names were chosen only to coexist with the
legacy tokens. Once those are gone, rename:

- `--color-fg` → `--color-foreground`
- `--color-fg-muted` → `--color-foreground-muted`
- `--color-fg-subtle` → `--color-foreground-subtle`
- `--color-edge` → `--color-border`
- `--color-edge-strong` → `--color-border-strong`

This is a mechanical find-replace across `src/`. Suggested grep targets:

```
text-fg              → text-foreground
text-fg-muted        → text-foreground-muted
text-fg-subtle       → text-foreground-subtle
bg-fg/               → bg-foreground/
border-fg/           → border-foreground/
border-edge-strong   → border-border-strong
border-edge          → border-border
```

(Don't run that as a blind script — the Tailwind opacity-modifier
suffixes need to ride along. A careful editor pass with `rg --files-with-matches`
followed by per-file review is safer.)

### 3. Delete legacy font setup

In `src/app/layout.tsx`:

- Remove `Bebas_Neue` and `Inter` imports.
- Remove `bebasNeue` and `inter` font instances and their CSS-var
  declarations from the `<html>` className.

In `src/app/globals.css` (`@theme`):

- Remove `--font-display: var(--font-display-bebas), ...`
- Remove `--font-sans: var(--font-sans-inter), ...`
- Rename `--font-broadcast-display` → `--font-display`.
- Rename `--font-broadcast-body` → `--font-sans`.

Then mechanical rename across `src/`:

```
font-broadcast-display → font-display
font-broadcast-body    → font-sans
```

After rename, `font-display` and `font-sans` Tailwind utilities resolve
to Antonio and Manrope. Type-role utilities (`type-display`, `type-h1`,
etc.) reference `--font-broadcast-display` directly; update those
references to `--font-display` in the same pass.

---

## Account-tier rename (logged during fighter-card migration)

The fighter-card pass renamed the existing `--color-tier-bronze/-silver/-gold/-diamond/-champion`
tokens to `--color-account-tier-*` to free the `tier-*` namespace for the
score-derived fighter tier system (`--color-tier-apex/-elite/-established/-roster`).
Badge variants were renamed in lockstep: `tier-bronze` → `account-tier-bronze`
(and the four siblings).

The rename is mechanical; **the account-tier visual surfaces themselves were
not migrated to Sodium tokens in this pass** because they barely render the
account tier as colour anywhere in the live UI:

- `leaderboard-table.tsx`'s `TierChip` already opted out of the tier palette
  in the Phase 1 leaderboard migration — *"no invented per-tier colour, the
  tier vocabulary is account-tier, not fighter-tier"*. Reads from neutral
  foreground tokens.
- `profile/tier-progress.tsx` displays tier *labels* and a progress bar, no
  account-tier chroma.
- `daily-bonus-button.tsx` only consumes the tier numeric thresholds.
- `style/page.tsx` is the only place that actively paints the account-tier
  hues — and only in the documented design-system swatch grid.

Cleanup options for a future pass:

1. **Delete the account-tier tokens entirely** (only consumed by Badge
   variants no live surface uses) — simplest. Badge tier variants would go
   with them; surfaces that grow a need for account-tier colour later can
   reach for the new fighter-tier palette or introduce a fresh system.
2. **Keep but retune for Sodium** if account-tier surfaces ever need real
   colour (e.g. profile flair / unlock celebrations). The current bronze/
   silver/gold/diamond/champion values were tuned for the legacy cool-blue
   palette and may read off on the warm surface.

Default expectation: option 1 when no surface has reached for them across a
full Sodium migration cycle.

## Out-of-scope colour leaks (logged during Phase 1 token audit)

These bypass the token layer and should be routed back through it
during their respective rebrand-migration waves.

- **`src/components/fighter/detail/CareerTimeline.tsx`** — hardcoded
  OKLCH values for W/L dot fills (e.g. `return "oklch(0.65 0.15 145)"`).
  Route through `--color-profit` / `--color-loss` (the new
  result-semantic tokens) when the timeline surface migrates.

- ~~**`src/components/fighter/FighterAvatar.tsx`** and
  **`src/components/fighter/detail/FighterHero.tsx`** — both define an
  `AVATAR_BG_PALETTE` array of 6 deterministic deep tints. The arrays
  are identical between the two files. Pull into a shared module under
  `src/lib/` (e.g. `src/lib/avatar-palette.ts`).~~ **Done in the
  catalog polish pass.** The shared module now lives at
  `src/lib/avatar-palette.ts`. The palette also neutralised — the
  saturated red/gold/blue/purple/green tints became a 4-step neutral
  Sodium-tinted dark ramp (the red one was falsely echoing the
  loss-red semantic on real catalog data).

- **`src/components/fighter/fighter-result-card.tsx`** — inline OKLCH
  gradient + colour values bypass tokens (e.g.
  `"linear-gradient(180deg, transparent, oklch(0.14 0.01 240 / 0.7))"`).
  Verify intent during the result-card migration wave.

- **`src/app/style/page.tsx`** — radial-gradient with inline OKLCH on
  what looks like a style-guide route. Likely intentional; verify
  during cleanup.

- **`src/lib/og.ts`** — `OG_COLORS` is hex-encoded by necessity
  (`ImageResponse` in `next/og` does not read CSS variables). This is a
  permanent exception, not debt — but it does mean OG images must be
  re-tinted manually when the brand palette changes. Cross-reference
  with `--color-surface-base` / `--color-fg` / `--color-accent` and
  update the hex values when the rebrand is locked in.

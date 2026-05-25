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

Tier tokens (`--color-tier-*`) stay until the tier system is rethought
in its own pass.

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

## Out-of-scope colour leaks (logged during Phase 1 token audit)

These bypass the token layer and should be routed back through it
during their respective rebrand-migration waves.

- **`src/components/fighter/detail/CareerTimeline.tsx`** — hardcoded
  OKLCH values for W/L dot fills (e.g. `return "oklch(0.65 0.15 145)"`).
  Route through `--color-profit` / `--color-loss` (the new
  result-semantic tokens) when the timeline surface migrates.

- **`src/components/fighter/FighterAvatar.tsx`** and
  **`src/components/fighter/detail/FighterHero.tsx`** — both define an
  `AVATAR_BG_PALETTE` array of 6 deterministic deep tints. The arrays
  are identical between the two files. Pull into a shared module under
  `src/lib/` (e.g. `src/lib/avatar-palette.ts`). This is independent of
  the rebrand and can ship sooner.

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

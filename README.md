# Vertex MMA

AI-powered MMA fight simulator and community platform for fight fans. Vertex MMA combines a UFC fighter database, an ML-driven "what if X vs Y" simulator, a virtual LMSR bookmaker, prediction games, a fight-card poster builder, and an LLM-curated news feed.

## Tech stack

- **Next.js 16 (App Router)** + **TypeScript** in strict mode
- **React 19**
- **Tailwind CSS 4** — CSS-first config via `@theme` in `globals.css`
- **Drizzle ORM** + **Supabase** (Postgres, Auth, Storage)
- **Framer Motion** for animation (installed, not yet used)
- **Radix UI** primitives wrapped as a shadcn-style component library
- **Lucide React** for icons
- **pnpm** as the package manager

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in DATABASE_URL and Supabase keys
pnpm db:push                 # apply schema (no-op in Wave 1)
pnpm dev                     # http://localhost:3000
```

## Folder structure

```
src/
  app/
    (marketing)/       # public marketing pages (Wave 2+)
    (app)/             # authenticated app pages (Wave 2+)
    api/               # route handlers
    layout.tsx
    page.tsx           # design-system demo (temporary)
    globals.css        # Tailwind + @theme tokens
  components/
    ui/                # primitives (Button, Card, Input, Badge, ...)
    layout/            # Navbar, Footer, Container
    fighter/           # fighter components (Wave 2+)
    simulator/         # simulator components (Wave 3+)
    market/            # bookmaker components (Wave 4+)
    shared/            # cross-cutting components
  lib/
    db/                # Drizzle schema + client
    supabase/          # server, browser, middleware clients
    utils.ts           # cn(), formatRecord(), formatCoins(), slugify()
    constants.ts       # weight classes, methods, bout statuses, tier levels
  hooks/               # React hooks
  types/               # global TypeScript types
public/
  fonts/
  images/
drizzle.config.ts
```

## Scripts

- `pnpm dev` — start the dev server
- `pnpm build` — production build
- `pnpm start` — start the production server
- `pnpm lint` — ESLint
- `pnpm type-check` — `tsc --noEmit`
- `pnpm db:push` — apply Drizzle schema to the database
- `pnpm db:studio` — open Drizzle Studio

## Roadmap

- **Wave 1 — Bootstrap (this PR):** project skeleton, design system, layout, demo page.
- **Wave 2 — Data & Auth:** Drizzle schema for fighters/events/bouts, Supabase auth flows, data ingestion pipeline.
- **Wave 3 — Simulator:** ML-driven matchup engine, fighter pages, simulator UI.
- **Wave 4 — Markets:** virtual currency, LMSR market maker, betting UI.
- **Wave 5 — Predictions & Cards:** tournament prediction games, fight-card poster builder.
- **Wave 6 — News:** LLM-curated news aggregator.

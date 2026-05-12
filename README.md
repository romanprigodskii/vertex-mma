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
pnpm dev                     # http://localhost:3000
```

## Database setup

1. Create a Supabase project (https://supabase.com).
2. Copy the credentials into `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` from **Project Settings → API**.
   - `DATABASE_URL` from **Project Settings → Database → Connection string → URI** (direct connection, port 5432; URL-encode the password).
3. In **Supabase → SQL Editor**, run the contents of [`drizzle/migrations/0000_enable_extensions.sql`](./drizzle/migrations/0000_enable_extensions.sql) once. `drizzle-kit push` runs without the privileges needed for `CREATE EXTENSION` on managed Postgres, so this step is manual.
4. `pnpm db:push` — applies the Drizzle schema (all tables + enums + indexes).
5. *(Optional)* `pnpm db:seed` — inserts 4 test fighters, a `UFC TEST` event, an Islam vs. Volkanovski main-event bout, and a winner market with two outcomes.

## Schema overview

The Drizzle schema lives under [`src/lib/db/schema/`](./src/lib/db/schema), split by domain:

| Module             | Tables                                                       |
| ------------------ | ------------------------------------------------------------ |
| `enums.ts`         | All `pgEnum` definitions (weight class, stance, method, …)  |
| `fighters.ts`      | `fighter`, `fighter_alias`, `fighter_stats_aggregate`        |
| `events.ts`        | `event`, `bout`, `bout_round_stats`                          |
| `users.ts`         | `user_profile`, `transaction`, `achievement`, `user_achievement` |
| `markets.ts`       | `market`, `market_outcome`, `bet`                            |
| `predictions.ts`   | `prediction_event`, `prediction_pick`, `prediction_event_result` |
| `cards.ts`         | `fight_card`, `fight_card_like`                              |
| `simulations.ts`   | `simulation`                                                 |
| `news.ts`          | `news_source`, `news_item` (with `pgvector` embedding column) |

Conventions:

- All public entities expose a `slug` for URL routing.
- UUIDs everywhere (no serial integers).
- Timestamps are `timestamp with time zone`.
- Fighter and alias names get `pg_trgm` GIN indexes for fuzzy search.
- `user_profile.auth_user_id` references `auth.users.id` from Supabase Auth without a hard FK (cross-schema).

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
- `pnpm db:seed` — insert minimal test data (fighters, event, bout, market)

## Roadmap

- **Wave 1 — Bootstrap (this PR):** project skeleton, design system, layout, demo page.
- **Wave 2 — Data & Auth:** Drizzle schema for fighters/events/bouts, Supabase auth flows, data ingestion pipeline.
- **Wave 3 — Simulator:** ML-driven matchup engine, fighter pages, simulator UI.
- **Wave 4 — Markets:** virtual currency, LMSR market maker, betting UI.
- **Wave 5 — Predictions & Cards:** tournament prediction games, fight-card poster builder.
- **Wave 6 — News:** LLM-curated news aggregator.

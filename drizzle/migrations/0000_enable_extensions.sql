-- Must be run manually in the Supabase SQL Editor BEFORE `pnpm db:push`.
-- drizzle-kit push runs without the superuser privileges required for CREATE EXTENSION on managed Postgres.

CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

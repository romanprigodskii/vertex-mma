# Self-hosted Postgres

The production database runs on the same VPS as the app since 2026-09-05. It is
no longer on Supabase.

## Why

Supabase ran the database on a `t4g.nano` burstable instance in eu-west-1 while
the app runs in Warsaw. Two costs came out of that, both measured:

| | Supabase (Ireland, Nano) | Self-hosted (same box) |
|---|---|---|
| Network round trip | 70 ms | 0.3 ms |
| 1M-iteration CPU probe | 21,400 ms | 232 ms |
| Rating lookup by fighter | 938 ms | 0.25 ms |
| Profile round-stats query | 1,179 ms | 1.0 ms |
| Full pass of the rating view | 107,000 ms | 443 ms |
| Query planning | 497 ms | 2.7 ms |

On 2026-09-04 the CPU side of that took the site down for most of a day. The
billing side was $34.65/month for two projects whose entire usage-based charges
came to $0.00 after included quotas.

## What runs where now

- **Postgres 17** in the `vertex-postgres` container on this box. Data lives in
  the `vertex-pgdata` docker volume.
- **Reachable two ways**: as `vertex-postgres:5432` on the `coolify` docker
  network, which is how the app connects, and on `127.0.0.1:5433` on the host,
  which is how the cron scripts connect. No public port is published.
- **Still on Supabase**: authentication (Google OAuth, sign-up and password
  reset email) and the 5,036 fighter photos in storage. Those move separately;
  self-hosted auth needs an SMTP provider, which Supabase was supplying.

The password is in `/opt/vertex-db/pgpass` (mode 600) and appears in exactly two
places: the Coolify environment variable, and the cron checkout's `.env.local`.

## Differences from the Supabase schema

- `user_profile.auth_user_id` no longer carries a foreign key to `auth.users`.
  It could not: auth still lives on Supabase, so a local `auth.users` would be a
  stale copy and every new sign-up would fail the constraint. The column is a
  plain uuid now, and the application is what keeps it honest.
- `auth.uid()`, `auth.role()`, `auth.email()` and `auth.jwt()` exist as stubs so
  the 13 RLS policies that call them still restore and evaluate. They read the
  same settings PostgREST would set and return NULL on a direct connection,
  which is what a direct connection saw on Supabase too.
- `pg_trgm` and `vector` live in `public`, `uuid-ossp` and `pgcrypto` in
  `extensions`, matching Supabase's layout so schema-qualified defaults and
  operator classes resolve unchanged. `pg_dump --schema=public` does NOT carry
  extensions, so these are created before any restore.

## Restoring from Supabase, or rolling back

Rollback is one environment variable. The Supabase project is still there, and
its data is whatever it held at the cutover.

    # app: /opt/vertex-db/database_url_backup.json holds the pre-cutover value
    # cron: /opt/vertex-db/env.local.backup holds the pre-cutover .env.local

Re-dump and re-restore, if it ever comes to that:

    pg_dump "$SUPABASE_URL" --schema=public --no-owner --no-privileges \
      --no-publications --no-subscriptions -Fc -f vertexmma.dump
    psql -f ops/db/bootstrap.sql          # roles, schemas, extensions, auth stubs
    pg_restore -d vertexmma --no-owner --no-privileges --jobs=3 vertexmma.dump

Expect exactly two ignorable errors: `schema "public" already exists`, and the
`auth.users` foreign key described above.

## The other database

`vertexboxing` moved onto the same instance on 2026-09-05, for the same reasons
minus the latency one: that project is not deployed anywhere, so its database
was paying Supabase rent to sit idle. It came across clean — 9 tables, 645,940
rows, 48 indexes and 34 constraints identical on both sides — and it needed none
of the special handling above: no RLS, no `auth.uid()` callers, no pgvector, no
foreign keys into `auth`. Only the `extensions` schema, for the same qualified
column defaults.

It shrank from 725 MB to 328 MB on the way over. That difference was bloat, not
data; a restore rewrites every table.

That project runs on a laptop rather than on this box, and Postgres here is
deliberately not published to the internet, so it connects over an SSH tunnel:
`./scripts/db-tunnel.sh` in the vertexboxing repo forwards `127.0.0.1:5433` to
this instance, and its `.env.local` already points there.

## Backups

Supabase was taking daily backups. That is now this box's job — see
`ops/db/backup.sh` and its cron entry at 02:00. It discovers the databases at
run time instead of listing them, so one added later is not silently left
unprotected, and it verifies each dump with `pg_restore --list` before pruning
anything, because a backup nobody has ever read is not a backup. Both databases
together are under 100 MB compressed, so 14 days of retention costs nothing.

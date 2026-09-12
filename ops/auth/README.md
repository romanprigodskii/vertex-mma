# Authentication

Self-hosted [GoTrue](https://github.com/supabase/auth) — the same service that
backed the hosted Supabase project — talking to the Postgres already running on
this box.

## Why this exists

The hosted Supabase project was deleted. That took the auth service with it:
`ctixvxfmgrthnspfofsc.supabase.co` does not resolve, so sign-in, sign-up and
every `supabase.auth.getUser()` on every request were failing. It also took
`auth.users` — **the accounts themselves are gone**. Emails and password hashes
were not in the dump that moved the database here; the `auth` schema arrived
empty. Nobody's old password works, because there is nothing to check it
against. The six profiles that outlived their accounts were deleted rather than
left squatting on usernames.

Only auth is self-hosted. The app reads the database through Drizzle rather than
PostgREST, and images come from `ops/photos`, so the rest of the platform —
PostgREST, Realtime, Storage, Studio, Kong — is not running and not needed.

## Shape

    browser ──> https://vertexmma.com/supabase/auth/v1/...
                          │  Traefik strips /supabase/auth/v1
                          ▼
                   auth-vertexmma (GoTrue :9999)
                          │
                          ▼
                   vertex-postgres  (vertexmma, schema auth)

supabase-js builds its endpoints as `<url>/auth/v1/...`, so pointing
`NEXT_PUBLIC_SUPABASE_URL` at `https://vertexmma.com/supabase` and stripping
that prefix at the edge is all the routing Kong would have done. Path-based, so
no new DNS record and no second certificate.

Application code was not rewritten: `@supabase/ssr` still manages the session,
and only the URL and the two keys changed.

## Secrets

`/opt/vertex-auth/.env` on the VPS, mode 600, not in git:

| Key | What it is |
| --- | --- |
| `GOTRUE_JWT_SECRET` | Signs access tokens. The anon and service-role keys are JWTs signed with it, so rotating it invalidates both. |
| `AUTH_DB_PASSWORD` | Password for the `supabase_auth_admin` Postgres role. |
| `GOTRUE_MAILER_AUTOCONFIRM` | `true` while there is no mail transport. |
| `GOTRUE_SMTP_*` | Empty until a provider is wired up. |

The app's `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
JWTs minted from `GOTRUE_JWT_SECRET` with `{"role": "anon"}` and
`{"role": "service_role"}`. They live in Coolify's environment variables.

## Email is not wired up

There is no SMTP configured, which has two consequences:

* `GOTRUE_MAILER_AUTOCONFIRM=true` — a new account is usable immediately,
  because a confirmation link could never arrive. Sign-up asks the user to check
  their email and nothing is sent; the account works anyway.
* **Password reset does not work.** `/auth/forgot-password` accepts the address
  and reports success (it deliberately never discloses whether an account
  exists), but no mail goes out.

To fix both, put a provider's SMTP credentials in `/opt/vertex-auth/.env`, set
`GOTRUE_MAILER_AUTOCONFIRM=false`, and `docker compose up -d`. `docs/email-setup.md`
describes the Resend domain setup that was in place for the hosted project; the
domain records survive, only an API key is needed.

## Google sign-in is off

It was configured in the hosted dashboard and that configuration is gone.
Re-enabling it needs an OAuth client whose authorized redirect URI is
`https://vertexmma.com/supabase/auth/v1/callback`, then
`GOTRUE_EXTERNAL_GOOGLE_ENABLED=true` plus client id and secret. The button was
removed from the sign-in and sign-up forms in the meantime.

## Operating it

    scp ops/auth/docker-compose.yml root@<vps>:/opt/vertex-auth/
    ssh root@<vps> 'cd /opt/vertex-auth && docker compose up -d'

    curl https://vertexmma.com/supabase/auth/v1/health
    curl https://vertexmma.com/supabase/auth/v1/settings

## Things that had to be repaired by hand

Both are captured in `drizzle/migrations/0099_selfhosted_auth_restore.sql`, which
is idempotent and should be re-run after any future auth migration.

1. **Ownership.** Every `auth` object inherited from the old dump was owned by
   `postgres`. GoTrue connects as `supabase_auth_admin` and runs
   `CREATE OR REPLACE` over its own schema at boot, so it crash-looped on
   `must be owner of function uid` until the schema was handed over.
2. **Triggers.** `on_auth_user_created` mirrors a new auth user into
   `public.user_profile` (with a sanitised, unique username) and
   `on_auth_user_deleted` cascades a deletion back. Both hang off `auth.users`,
   so they could not be restored until GoTrue had recreated that table. The
   trigger *functions* are in `public` and survived.

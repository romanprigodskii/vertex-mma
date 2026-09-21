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
| `GOTRUE_MAILER_AUTOCONFIRM` | `true` while there is no mail transport; `false` once there is. |
| `GOTRUE_SMTP_*` | Empty until a provider is wired up. |

The app's `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
JWTs minted from `GOTRUE_JWT_SECRET` with `{"role": "anon"}` and
`{"role": "service_role"}`. They live in Coolify's environment variables.

## Email

Everything but the transport is in place and was tested end to end on
2026-09-21 against a local mail catcher (below): sign-up confirmation, password
reset and the two-link email change all complete from the link in the email.

* **Links** go to GoTrue's own `/verify`, which checks the token and redirects to
  the app's `/auth/callback` with a code. The paths in the compose file carry
  the `/supabase` prefix explicitly — GoTrue resolves them against
  `API_EXTERNAL_URL` as URL references, where an absolute path replaces the base
  path rather than extending it.
* **Templates** are `templates/*.html`. GoTrue fetches a body over HTTP rather
  than reading a file, so the `templates` service serves them on a network only
  GoTrue can reach. A failed fetch falls back to GoTrue's plain default, so a
  grey unbranded email means that service is down. Subjects are in the compose
  file. Links expire after an hour (`GOTRUE_MAILER_OTP_EXP`), and the templates
  say so — change both together.

**What is missing is SMTP credentials**, so for now:

* `GOTRUE_MAILER_AUTOCONFIRM=true` — a new account is signed in immediately,
  because a confirmation link could never arrive.
* **Password reset does not work.** `/auth/forgot-password` accepts the address
  and reports success (it deliberately never discloses whether an account
  exists), but GoTrue's no-op mailer sends nothing.

To switch mail on, with a Resend API key (`docs/email-setup.md`; the domain is
already verified there and its DNS records are live):

    # /opt/vertex-auth/.env
    GOTRUE_SMTP_HOST=smtp.resend.com
    GOTRUE_SMTP_PORT=587
    GOTRUE_SMTP_USER=resend
    GOTRUE_SMTP_PASS=re_...
    GOTRUE_MAILER_AUTOCONFIRM=false

    cd /opt/vertex-auth && docker compose up -d

Then sign up with a real address and run a password reset.

### Testing mail without a provider

An override pointing GoTrue at [Mailpit](https://mailpit.axllent.org) catches
every message on the box. Messages are read through GoTrue's container, since
the catcher sits on the internal network with nothing published:

    # /opt/vertex-auth/docker-compose.mailtest.yml — delete when done
    services:
      auth:
        environment:
          GOTRUE_SMTP_HOST: auth-mailpit
          GOTRUE_SMTP_PORT: "1025"
          GOTRUE_SMTP_USER: ""
          GOTRUE_SMTP_PASS: ""
      mailpit:
        image: axllent/mailpit:v1.27
        container_name: auth-mailpit
        networks: [templates]

    docker compose -f docker-compose.yml -f docker-compose.mailtest.yml up -d
    docker exec auth-vertexmma wget -qO- http://auth-mailpit:8025/api/v1/messages

With autoconfirm on, a reset still sends mail, so that flow can be tested
without touching sign-up. Add `GOTRUE_MAILER_AUTOCONFIRM: "false"` to test
confirmation and the two-link email change — autoconfirm also makes an email
change complete on the first link — but keep that window short: a real sign-up
during it waits on a mail that goes to the catcher. Afterwards, `docker compose
up -d --remove-orphans` with the plain file and `docker rm -f auth-mailpit`.

## No Google sign-in

It was configured in the hosted dashboard, went with it, and is not coming
back: email and password is the only way in. The button is gone from the forms,
and the settings page asks every account for its current password before an
email change or deletion. Bringing Google back would mean an OAuth client with
redirect URI `https://vertexmma.com/supabase/auth/v1/callback`,
`GOTRUE_EXTERNAL_GOOGLE_ENABLED=true` with its id and secret, and a
passwordless path through those two settings checks.

## Operating it

    scp ops/auth/docker-compose.yml root@<vps>:/opt/vertex-auth/
    scp ops/auth/templates/*.html root@<vps>:/opt/vertex-auth/templates/
    ssh root@<vps> 'cd /opt/vertex-auth && docker compose up -d'

    curl https://vertexmma.com/supabase/auth/v1/health
    curl https://vertexmma.com/supabase/auth/v1/settings

GoTrue caches fetched templates and only refetches them after a while, so to
pick up an edited template at once, `docker compose restart auth`.

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

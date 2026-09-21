# Email setup: Resend SMTP

Goal: outbound auth emails (sign-up confirmation, password reset, email
change) sent from `noreply@vertexmma.com` with the dark Vertex MMA templates.

Auth is self-hosted GoTrue (`ops/auth`), so everything that used to be a
Supabase dashboard setting is now an environment variable in
`/opt/vertex-auth/.env` on the VPS. The templates, subjects and link paths are
already configured in `ops/auth/docker-compose.yml`; what is needed is an SMTP
transport. Resend is the one the domain is set up for.

## State as of 2026-09-21

- The Resend DNS records for `vertexmma.com` are live in Cloudflare: DKIM at
  `resend._domainkey`, SPF and MX (`feedback-smtp.eu-west-1.amazonses.com`) at
  `send`. They survived the Supabase deletion; nothing about them depended on it.
- There is no `_dmarc` record.
- The old API key was pasted into the Supabase dashboard and went with it. A new
  one is the only missing piece.

## Step 1 — API key

1. https://resend.com → sign in with the account that owns the domain.
2. **Domains** → `vertexmma.com` should show as verified. If the account or the
   domain is gone, add the domain again: Resend issues new records to put in
   Cloudflare (all **DNS only**, grey cloud — proxied breaks the lookups), then
   **Verify**.
3. **API Keys** → **Create API Key**. Name `vertexmma-production-smtp`,
   permission **Sending access**, domain `vertexmma.com`. Copy the `re_…`
   secret straight away; Resend never shows it again.

## Step 2 — Give it to GoTrue

On the VPS, in `/opt/vertex-auth/.env`:

    GOTRUE_SMTP_HOST=smtp.resend.com
    GOTRUE_SMTP_PORT=587
    GOTRUE_SMTP_USER=resend
    GOTRUE_SMTP_PASS=re_...
    GOTRUE_MAILER_AUTOCONFIRM=false

then `cd /opt/vertex-auth && docker compose up -d`.

`GOTRUE_MAILER_AUTOCONFIRM=false` is what makes sign-up send a confirmation
email instead of signing the account in at once. Leave it `true` and mail still
flows for password reset and email change, but addresses go unverified.

## Step 3 — End-to-end test

1. Sign up on https://vertexmma.com/signup with a real address.
2. Expected: from `Vertex MMA <noreply@vertexmma.com>`, subject "Confirm your
   email · Vertex MMA", dark body with an orange button. The button lands you on
   the site, signed in.
3. Sign out, run **Forgot password**, follow the email, set a new password,
   sign in with it.
4. Settings → change email: a link goes to both the old and the new address, and
   the change applies only once both are clicked.

## Step 4 (optional) — DMARC

A `_dmarc` TXT record, e.g. `v=DMARC1; p=none; rua=mailto:<you>`, helps
deliverability to Gmail and Outlook. `p=none` only asks for reports; it
rejects nothing.

---

## Troubleshooting

**Mail never arrives.**
- `docker logs auth-vertexmma` — an SMTP error shows there, and the app shows
  the user a generic error rather than a false success.
- Resend Dashboard → **Logs** → outbound attempts. `403` usually means the
  domain is not verified.
- Look in spam — Gmail occasionally flags a new sender on its first send.

**Mail arrives, but grey and unbranded.** GoTrue could not fetch the template
and fell back to its default: check that `auth-vertexmma-templates` is running.

**The link lands on "link expired".** Links last an hour and work once. With
PKCE, the link also has to be opened in the browser that asked for it — one
opened on another device can't complete the exchange.

## Limits — two caps, raise both

1. **Resend free tier: 3,000/month, 100/day.** The daily cap is what throttles
   registrations first. Pro ($20/month) raises it to 50,000/month with no daily
   cap; the API key and settings stay as they are.
2. **GoTrue: 30 emails/hour across all users** (`GOTRUE_RATE_LIMIT_EMAIL_SENT`
   in the compose file). It only bites in a burst — over a day, Resend's 100
   runs out first — so there is no point raising it before the plan changes.

Password resets and email changes draw on the same budget, and an email change
sends two.

## Future

- Marketing/newsletter sends: use a separate sender like `news@vertexmma.com`
  so transactional deliverability isn't hit by bulk reputation.
- The templates are English only. GoTrue has one template per type, so a
  Russian version would mean branching inside the template on user metadata.

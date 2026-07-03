# Email setup: Resend SMTP + custom templates

Goal: outbound auth emails (signup confirmation, password reset, magic link,
email change) sent from `noreply@vertexmma.com` with dark Vertex MMA
branding instead of the default Supabase-grey from `noreply@mail.app.supabase.io`.

## Prerequisites

- `vertexmma.com` registered and active on Cloudflare DNS
- Supabase project with Auth enabled (the project this repo points at)
- Cloudflare account access for DNS edits

---

## Step 1 — Resend account

1. https://resend.com → sign up (use the email you'd want associated with the project).
2. Verify the address.
3. Free tier: 3 000 emails/month, 100/day. Comfortably enough for early users.

## Step 2 — Add and verify the domain

1. Resend Dashboard → **Domains** → **Add Domain**.
2. Enter `vertexmma.com` (apex).
3. Resend issues DNS records:
   - **MX** for the return-path subdomain (value like `feedback-smtp.us-east-1.amazonses.com`)
   - **TXT (SPF)** — `v=spf1 include:amazonses.com ~all`
   - **TXT (DKIM)** — long key starting `p=...` at name `resend._domainkey`
   - **TXT (DMARC)** — `v=DMARC1; p=none; rua=mailto:...` at name `_dmarc`

Keep the Resend tab open — you'll copy each value into Cloudflare.

## Step 3 — Add DNS records in Cloudflare

1. Cloudflare Dashboard → `vertexmma.com` → **DNS** → **Records**.
2. For each Resend record click **Add record** and paste:

   | Type | Name | Content | Priority | Proxy |
   |------|------|---------|----------|-------|
   | MX   | `send` (or whatever Resend specifies) | feedback host | 10 | DNS only |
   | TXT  | `send` or `@` | SPF value | — | DNS only |
   | TXT  | `resend._domainkey` | DKIM key | — | DNS only |
   | TXT  | `_dmarc` | DMARC policy | — | DNS only |

   **All four must be `DNS only` (grey cloud) — proxied/orange-cloud breaks
   the lookups Resend uses.**

3. Wait 5–30 min for DNS propagation.
4. Resend Dashboard → Domains → `vertexmma.com` → **Verify**. Each record
   should flip to ✅.

## Step 4 — Create an API key (used as SMTP password)

1. Resend Dashboard → **API Keys** → **Create API Key**.
2. Name: `vertexmma-production-smtp`. Permission: **Sending access**.
   Domain: `vertexmma.com`.
3. **Copy the secret immediately** (`re_xxx…`). Resend never shows it
   again.

Resend SMTP coordinates:

| Field | Value |
|-------|-------|
| Host | `smtp.resend.com` |
| Port | `465` (TLS) or `587` (STARTTLS) |
| Username | `resend` |
| Password | the API key you just copied |

## Step 5 — Wire SMTP into Supabase

1. Supabase Dashboard → your project → **Project Settings → Authentication
   → SMTP Settings**.
2. Toggle **Enable custom SMTP** = ON.
3. Fill:
   - **Sender name**: `Vertex MMA`
   - **Sender email**: `noreply@vertexmma.com`
   - **SMTP host**: `smtp.resend.com`
   - **SMTP port**: `465`
   - **SMTP user**: `resend`
   - **SMTP password**: the API key from Step 4
   - **Minimum interval**: leave default (1 s between emails)
4. **Save**.

Smoke test: Supabase Dashboard → Authentication → Users → pick any user →
**Send password recovery email**. The mail should arrive from
`noreply@vertexmma.com`.

## Step 6 — Paste the custom HTML templates

1. Supabase Dashboard → **Authentication → Email Templates**.
2. For each template, paste the matching HTML from `email_templates/`:
   - **Confirm signup** → `email_templates/confirm-signup.html`
   - **Magic Link** → `email_templates/magic-link.html`
   - **Reset Password** → `email_templates/reset-password.html`
   - **Change Email Address** → `email_templates/email-change.html`
3. Click **Save** on each.

The Supabase preview pane sometimes renders the dark theme against a light
backdrop — that's a preview-only quirk. Real-world clients honour the
`background:#0a0a0a` set on the `<body>`.

## Step 7 — End-to-end test

1. From a browser (local dev or production), sign up with a real email.
2. Expected:
   - From: `Vertex MMA <noreply@vertexmma.com>`
   - Subject: the one configured on the Supabase template
   - Dark HTML body, orange "Confirm email" button, 6-char OTP fallback
3. Click the button → flow completes.
4. Spot-check the other three flows: password reset, magic-link sign-in,
   email change.

---

## Troubleshooting

**Mail never arrives.**
- Resend Dashboard → **Logs** → check outbound attempts.
- If you see `400/403`: a DNS record is still pending; re-run **Verify**.
- Cloudflare records must be `DNS only` (grey). Proxied won't resolve.
- Look in spam — Gmail occasionally flags new domains on the first send.

**Mail still arrives from `noreply@mail.app.supabase.io`.**
- Supabase SMTP Settings → "Enable custom SMTP" must be **ON**. Toggle off
  re-enables the default Supabase sender.

**Dark template renders as light.**
- Some clients (especially Outlook) ignore `background-color` on `body`.
  The card itself stays `#171717`, button stays orange, text stays
  readable — the look just isn't fullscreen-black.
- Gmail dark mode renders the template correctly.

## Limits — TWO caps in the signup pipeline, raise BOTH

1. **Resend free tier: 3 000/month, 100/day.** The daily cap is what
   throttles registrations first. Upgrade to Pro ($20/month → 50 000/month,
   **daily cap removed entirely**) at resend.com → Billing. Pure billing
   change: the API key, Supabase SMTP settings, and DNS stay as-is.
2. **Supabase Auth email rate limit: 30/hour by default with custom
   SMTP** — hidden second cap that bites BEFORE Resend under a signup
   burst, even on a paid Resend plan. Raise it at Supabase Dashboard →
   Authentication → Rate Limits → "Rate limit for sending emails"
   (e.g. 300/hour).

Also consuming the same budget: password resets and email changes (an
email change sends TWO — old-address confirm + new-address verify).
Google OAuth signups send no email at all — the free relief valve.
Disabling "Confirm email" (Supabase → Auth) removes signup emails
entirely, at the cost of unverified addresses — not recommended past beta.

## Future

- The Wave 36 email-change action issues both an "old-address confirm" and
  a "new-address verify" — Supabase auto-uses the `Change Email Address`
  template for the new-address half. The old-address half uses the
  legacy reauth template (Supabase doesn't expose a separate template
  slot for it).
- Account-level notification preferences (opt out of, e.g., tier-upgrade
  emails) — when added, route through the notification subsystem rather
  than wiring per-template logic in Supabase.
- Marketing/newsletter sends: use a separate sender like
  `news@vertexmma.com` so transactional deliverability isn't impacted by
  bulk reputation hits.

# Vertex MMA — VPS deploy guide (Hetzner + Coolify)

End-to-end recipe for the recommended deployment path: a single small VPS
running the Next.js app behind Coolify's managed Traefik + Let's Encrypt
proxy, with Supabase as the database/auth/storage backend and Cloudflare
for DNS.

Total time to first deploy: ~30 minutes.
Cost: ~$6/month all-in (see [Cost summary](#cost-summary)).

## Choose VPS

**Recommended:** Hetzner Cloud
- **CX22:** €4.51/mo · 2 vCPU · 4 GB RAM · 40 GB disk — sufficient for MVP
- **CCX13:** €5.83/mo · 2 dedicated vCPU · 4 GB RAM · 80 GB disk — better
  for consistent performance under spikes

Alternatives: DigitalOcean Basic Droplet ($6/mo), Vultr ($6/mo), Linode ($5/mo).

**Location:** Nuremberg or Falkenstein (Germany) for an EU-leaning audience;
also acceptable latency for US East Coast.

## Step 1 — Provision server

1. Hetzner Cloud Console → **Create Server**
2. Image: **Ubuntu 24.04** (LTS)
3. Type: CX22 or CCX13
4. Location: Nuremberg or Helsinki
5. SSH key: upload your `~/.ssh/id_*.pub`
6. Networking: default IPv4 + IPv6
7. **Firewall:** create one allowing inbound TCP 22 (SSH), 80 (HTTP),
   443 (HTTPS) only
8. Create server → note the public IPv4

## Step 2 — Initial server hardening

```bash
ssh root@<server-ip>
apt update && apt upgrade -y
apt install -y curl ufw fail2ban
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

Optional but recommended for production: create a non-root user with sudo,
add your SSH key to that user, disable root SSH login in
`/etc/ssh/sshd_config` (`PermitRootLogin no`), then `systemctl restart ssh`.

## Step 3 — Install Coolify

Coolify is a self-hosted Vercel/Heroku clone. Free, open-source, ships with
Traefik + automatic Let's Encrypt SSL + git-based deploys + env management.

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Takes ~5 min. Coolify is then served on `http://<server-ip>:8000`. Open it
in your browser and create the admin account immediately (anyone who hits
that port first becomes admin).

## Step 4 — Configure the project in Coolify

1. Coolify Dashboard → **New Resource** → **Public Repository** (or
   **Private Repository** if you wire in GitHub auth)
2. Repository URL: `https://github.com/<your>/vertexmma`
3. Build pack: **Dockerfile** (auto-detected from `./Dockerfile`)
4. Port: **3000**
5. **Environment Variables** — add all of:

   | Key | Value | Build / Runtime |
   |---|---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project Settings → API → URL | both |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon public key | both |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key (SECRET) | runtime only |
   | `DATABASE_URL` | Supabase Database → **Session pooler** URL (port 5432) | runtime only |
   | `NEXT_PUBLIC_SITE_URL` | `https://vertexmma.com` | both |

   The `NEXT_PUBLIC_*` keys are baked into the client bundle at build time,
   so they must be marked **Build** in Coolify's env UI.

   **Pooler note:** a long-running Node container on a VPS keeps its
   connections open, so use the **session pooler (5432)**. The transaction
   pooler (6543) is for serverless / Vercel-style deployments where
   connection state can't survive between requests.

6. **Domains:** add `vertexmma.com`. Coolify auto-issues an HTTPS cert via
   Let's Encrypt once the DNS A record points at the server.
7. **Deploy.** Coolify pulls the repo, builds the Docker image, and runs
   the container.

## Step 5 — DNS records (Cloudflare)

In Cloudflare → vertexmma.com → DNS → Records:

| Type | Name | Value | Proxy |
|---|---|---|---|
| A    | @    | `<server-ip>` | **DNS only** (orange cloud OFF) |
| A    | www  | `<server-ip>` | **DNS only** |

Wait 5–30 min for propagation, then in Coolify click **Check Domain** —
the cert issues automatically.

> **Cloudflare proxy:** turning on the orange cloud gives you a free DDoS
> + caching layer, but it requires setting SSL mode to **Full (strict)** in
> Cloudflare or you get HTTPS redirect loops. Skip the proxy for v1
> simplicity; revisit when traffic justifies the extra config surface.

## Step 6 — Update Supabase Auth URLs

Supabase Dashboard → Project → **Authentication** → **URL Configuration**:

- **Site URL:** `https://vertexmma.com`
- **Redirect URLs:** add
  - `https://vertexmma.com/auth/callback`
  - `https://vertexmma.com/auth/reset-password`

Without these, Supabase rejects the OAuth redirect and signup/signin
silently breaks in production.

## Step 7 — Email setup

Resend domain verification + DNS records + Supabase SMTP config are
covered separately in [`docs/email-setup.md`](./email-setup.md). It's
independent of the server deploy — do it whenever you want real
transactional email instead of the (rate-limited) default Supabase SMTP.

## Step 8 — Scraper schedule (optional, post-launch)

The initial DB is already seeded; the scraper only needs to run to pick
up new events. Pick one when you're ready:

- **A — Cron on the server.** SSH in, clone the repo, install Python +
  pnpm, and add a crontab entry such as
  `0 3 * * * cd /opt/vertexmma && pnpm scrape:quick`.
- **B — GitHub Actions (recommended).** Add `.github/workflows/scrape.yml`
  with `DATABASE_URL` as a repo secret. Free, no server load.
- **C — Local laptop cron.** Same as today; works as long as your machine
  is on.

## Step 9 — Monitoring (optional, defer)

- Coolify ships with deployment logs and a container restart counter — fine
  for v1.
- Hetzner Cloud Console has built-in CPU / RAM / disk graphs.
- Add Sentry / PostHog later in dedicated waves.

## Step 10 — Deploy verification

1. `https://vertexmma.com` loads the home page
2. Sign up with a real email → confirmation arrives (requires Step 7 done)
3. Place a bet → balance decreases, bet shows in `/me/bets`
4. `/markets` renders the events accordion
5. `/api/og/rankings/<id>` returns a PNG
6. Coolify → app → **Logs** is clean of unexpected errors

## Backup strategy

- **Database:** Supabase free-tier auto-backups (point-in-time recovery is
  limited). For peace of mind, schedule a monthly `pg_dump` to S3 or local
  storage.
- **App code:** lives in Git; no separate backup needed.
- **Storage (avatars / photos):** Supabase Storage is replicated
  automatically.

## Rollback

Coolify → Deployments → click any past deployment → **Redeploy**. Instant
rollback to a known-good image, no DB changes required.

## Cost summary

| Item | Cost |
|---|---|
| Hetzner CX22 | €4.51/mo |
| Domain renewal (amortized) | ~$1/mo |
| Supabase Free | $0 (within limits) |
| Resend Free | $0 (3 000 emails/mo) |
| Cloudflare DNS | $0 |
| **Total** | **~$6/mo** |

Upgrade thresholds:
- Hetzner **CCX23** (€10/mo) — if memory pressure shows up above ~3 GB
- Supabase **Pro** ($25/mo) — at ~50 k MAU or 500 MB DB
- Resend **Pro** ($20/mo) — above 3 000 emails/month

---

## Alternative: manual VPS deploy (no Coolify)

If you'd rather skip Coolify, the repo also ships:

- `docker-compose.yml` — runs the same image, binds port 3000 to
  `127.0.0.1` so a host Nginx can proxy it
- `nginx/vertexmma.conf` — example vhost with Let's Encrypt paths;
  `sudo certbot --nginx -d vertexmma.com` fills in the rest

Steps roughly:

```bash
ssh root@<server-ip>
apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx
git clone https://github.com/<your>/vertexmma /opt/vertexmma
cd /opt/vertexmma
cp .env.example .env.production && $EDITOR .env.production   # fill in secrets
docker compose --env-file .env.production up -d --build
cp nginx/vertexmma.conf /etc/nginx/sites-available/vertexmma
ln -s /etc/nginx/sites-available/vertexmma /etc/nginx/sites-enabled/
certbot --nginx -d vertexmma.com -d www.vertexmma.com
systemctl reload nginx
```

The Coolify path is shorter, has a web UI for env vars, and re-deploys on
git push out of the box — recommended unless you have a strong reason to
roll your own.

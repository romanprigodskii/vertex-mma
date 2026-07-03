# Umami analytics (stats.vertexmma.com)

Self-hosted, privacy-friendly analytics (no cookies → no consent banner).
Lives on the VPS at `/opt/umami` (this compose file is the committed copy;
secrets are in `/opt/umami/.env`, chmod 600, NOT in git):

- `POSTGRES_PASSWORD`, `APP_SECRET` — generated at install
- `ADMIN_PASSWORD` — the Umami admin login password

Routing: Coolify's Traefik picks the container up via labels (same
`letsencrypt` certresolver / entrypoints as the main app). Requires the
Cloudflare A record `stats` → the VPS IP, proxy OFF (grey cloud).

- Dashboard: https://stats.vertexmma.com (login `admin`)
- Public share link (portfolio-safe, read-only):
  https://stats.vertexmma.com/share/f9823e4bd32148e5/vertexmma.com
- Website ID `c8b3ab7c-8b83-4f11-8d91-ed92c0d7987a` — referenced by the
  tracking <Script> in src/app/[locale]/layout.tsx (prod-only)
- Custom click events via `data-umami-event` attributes: signup-cta,
  lmsr-bet-place, sportsbook-bet-place, parlay-place, dream-fight-run

Ops:
- update:  cd /opt/umami && docker compose pull && docker compose up -d
- logs:    docker logs umami --tail 50
- backup:  the volume `umami_umami-db-data` holds all analytics data

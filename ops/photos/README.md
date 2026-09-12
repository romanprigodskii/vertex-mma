# Image origin

Static nginx serving the images we host ourselves:

* `https://vertexmma.com/fighter-photos/<slug>/{full,thumbnail}.webp`
* `https://vertexmma.com/avatars/<auth-user-id>/avatar.<ext>`

## Why this exists

Fighter photos used to live in a Supabase storage bucket. That project was
deleted — `ctixvxfmgrthnspfofsc.supabase.co` no longer resolves — which took
2,400 photos with it and left every `fighter.photo_url` pointing at nothing.

The breakage was uneven and therefore easy to misread: the homepage renders its
avatars as a plain `<img>`, so those went to broken-image icons immediately,
while `/fighters` goes through `next/image` and kept rendering out of the
optimizer's on-disk cache inside the running container. That cache does not
survive a redeploy, so both were broken; only one of them looked it.

## Shape

Path-routed on the existing domain, the same trick `/model` uses: a
higher-priority Traefik router claims `/fighter-photos/` on `vertexmma.com` and
sends it here, so there is no new DNS record and no second certificate.
Everything else on the host keeps flowing to the app. Standalone compose — the
Coolify UI does not manage it.

    /opt/vertex-photos/
      docker-compose.yml
      nginx.conf
      html/fighter-photos/<slug>/full.webp
                                /thumbnail.webp
           avatars/<auth-user-id>/avatar.webp

`html/avatars` is bind-mounted into the application container at `/app/avatars`
(Coolify persistent storage, owned `1001:65533` — the `nextjs` user the image
runs as, which the volume's chown carries across redeploys) and the app writes
uploads straight into it — see `src/lib/avatar-store.ts`. Avatars used to go through Supabase Storage; with the
app and the origin on the same box, a shared directory replaces a storage
service and an API key. `AVATAR_DIR` is the app's side of that mount; with it
unset, uploads fail loudly instead of writing somewhere nothing serves.

## Operating it

Deploy or restart:

    scp ops/photos/{docker-compose.yml,nginx.conf} root@<vps>:/opt/vertex-photos/
    ssh root@<vps> 'cd /opt/vertex-photos && docker compose up -d'

Publish photos (from a machine with a residential IP — ufc.com 403s the VPS):

    scripts/photo_scraper/scripts/publish_photos.sh

Check it is serving:

    curl -I https://vertexmma.com/fighter-photos/healthz

A missing file is a normal 404, not an error: the app falls back to an initials
tile whenever `photo_url` is NULL or the image fails to load.

Two fighters have no photo at all — their UFC pages no longer carry an image —
so their rows are NULL and they render as initials. A later
`fetch_photos_ufc.py` run will pick them up if UFC ever republishes one.

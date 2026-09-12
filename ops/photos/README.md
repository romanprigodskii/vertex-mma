# Fighter photo origin

Static nginx serving `https://vertexmma.com/fighter-photos/<slug>/{full,thumbnail}.webp`.

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

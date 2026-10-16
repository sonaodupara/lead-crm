# Deploying to your Hostinger VPS

Needs a VPS with Docker (Ubuntu 22.04/24.04 is fine) and a domain or sub-domain pointing at the VPS IP
(an `A` record), e.g. `service.yourdomain.in`.

```bash
# 1. get the code
git clone https://github.com/sonaodupara/lead-crm.git && cd lead-crm/service-hub
git checkout claude/inventory-zoho-integration-app-86frdy     # until it is merged

# 2. configure
cp .env.production.example .env
nano .env        # DOMAIN, POSTGRES_PASSWORD, JWT_SECRET (use: openssl rand -hex 32), Zoho values later

# 3. start (builds the image, starts Postgres, the app and HTTPS)
docker compose up -d --build

# 4. create the first owner login (once)
docker compose run --rm -e SEED_OWNER_EMAIL=you@example.com -e SEED_OWNER_PASSWORD='a-long-password' app node dist/seed.js
```

Open `https://<your domain>` and sign in. Database tables are created automatically on every start.
Then: add users (People & settings), create warranty terms, connect Zoho (docs/ZOHO.md).

## Safety

* Only ports 80 and 443 are open; Postgres is not reachable from outside Docker.
* Enable the firewall: `ufw allow 22,80,443/tcp && ufw enable`.
* Use a strong `JWT_SECRET`; the app refuses to start in production with a weak one.
* Give every person their own login. Technicians use their own phones: **install the app** from the browser
  menu (“Add to Home screen”) so it opens offline.

## Backups (do this on day one)

```bash
# nightly database dump, keep 14 days  (crontab -e)
0 2 * * * cd /root/lead-crm/service-hub && docker compose exec -T db pg_dump -U servicehub servicehub | gzip > /root/backups/servicehub-$(date +\%F).sql.gz && find /root/backups -name 'servicehub-*.sql.gz' -mtime +14 -delete
```

Uploaded photos and bill scans live in the `uploads` Docker volume — back that up too
(`docker run --rm -v service-hub_uploads:/d -v /root/backups:/b alpine tar czf /b/uploads-$(date +%F).tgz -C /d .`).
Copy backups off the server. Test a restore once.

Restore: `gunzip -c backup.sql.gz | docker compose exec -T db psql -U servicehub servicehub` (into an empty database).

## Updating

```bash
git pull && docker compose up -d --build
```

Migrations run automatically and are applied once each. Logs: `docker compose logs -f app`.

## Without Docker

Node 22 and PostgreSQL 16: set the variables from `api/.env.example`, then
`cd web && npm ci && npm run build`, `cd ../api && npm ci && npm run build && WEB_DIST=../web/dist node dist/index.js`
behind any HTTPS reverse proxy (nginx/Caddy).

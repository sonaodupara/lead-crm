# Saiph Service Hub

Inventory, batch/serial tracking, warranty, AMC and field-service management that sits beside Zoho.
Zoho stays the books of record; this app owns serial/batch/warranty/service data. Sales invoices are pushed to
Zoho as **drafts** for the accountant to review; purchase bills are created as open bills (Zoho has no bill drafts), so they are only sent when an accountant presses *Send to Zoho*.

| Part | Stack |
|---|---|
| `api/` | Node 20+, Fastify, TypeScript, PostgreSQL (plain SQL migrations) |
| `web/` | React + Vite PWA (phone and desktop, offline queue for technicians) |

Docs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/ZOHO.md`](docs/ZOHO.md) · [`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md)

## Run locally

```bash
cd api
cp .env.example .env            # edit DATABASE_URL, JWT_SECRET
npm install
SEED_OWNER_EMAIL=you@example.com SEED_OWNER_PASSWORD='choose-a-long-one' npm run seed
npm run dev                     # http://localhost:4000
```

## Tests

```bash
cd api
# needs any throwaway Postgres; the database name must contain "test" (it is dropped and recreated)
TEST_DATABASE_URL='postgres://postgres@localhost/servicehub_test' npm test
```

# Architecture

```
 phones / desktops ──HTTPS──▶ Caddy ──▶ Fastify API + built React app ──▶ PostgreSQL
                                              │
                                              └── outbox worker ──▶ Zoho POS (or Books), India DC
```

* **web/** React + Vite. One build, two experiences: a phone-first technician app (offline queue, camera,
  signature, barcode scan) and a desktop layout for the office. Installable (PWA).
* **api/** Fastify + TypeScript. Plain SQL migrations (`api/migrations`), no ORM. Business rules live in
  `api/src/lib` and are unit-tested; routes are thin.
* **Postgres** is the single store for everything the app owns.

## Rules the code enforces

| Rule | Where |
|---|---|
| Stock is a **ledger** (`stock_movements`); on-hand is a sum, never an edited number. | `lib/stock.ts` |
| Receiving a bill creates batches, serial units and ledger rows in one transaction. | `lib/documents.ts` |
| Confirming an invoice issues stock, sells the serials and **starts each warranty on the invoice date**. A shortage anywhere aborts the whole confirmation. | `lib/documents.ts` |
| Each warranty keeps a **frozen copy of its terms**; editing a template never rewrites warranties already sold. | `warranties.terms_snapshot` |
| Template resolution: batch → item → category rule → brand rule → default rule. No rule ⇒ no warranty (nothing is assumed). | `lib/warranty.ts` |
| A job's **coverage** (in warranty / out of warranty / AMC / goodwill) is suggested from the unit's records; only a supervisor/owner can override, and a reason is recorded. | `lib/jobs.ts` |
| Technicians draw parts **from the store at the point of use**; a shortfall is recorded and flagged, never blocks the visit. | `lib/jobs.ts` |
| Chargeable jobs become a draft invoice (parts + labour + travel); stock is not issued a second time. | `createJobInvoice` |
| AMC: per-visit billing creates an invoice per completed visit; annual billing one invoice for the term. Due visits become jobs automatically. | `lib/amcService.ts` |
| Sales invoices reach Zoho **only as drafts**; purchase bills are created as **open** bills (Zoho Books has no draft state for them). Both go through an idempotent outbox. | `zoho/` |

## Offline technicians

Every technician action — online or offline — is queued on the phone (IndexedDB) and sent through one
idempotent endpoint (`POST /api/sync/push`). Each operation has a client-generated id; the server records it
(`client_ops`), so retrying after a dropped connection never duplicates a part, a check-in or a completion.
Photos and signatures upload first (also idempotent by client id), then the operations that reference them.
Phone clocks are corrected with the offset measured at the last server contact. The app shell is precached by
a service worker, so the app opens with no signal and shows the last downloaded jobs.

## Roles

| | Owner | Supervisor | Accountant | Sales | Technician |
|---|:-:|:-:|:-:|:-:|:-:|
| Own assigned jobs, check-in, parts, photos, sign-off | ✓ | ✓ | | | ✓ |
| Create / assign / close jobs, override coverage | ✓ | ✓ | | | |
| Create jobs from a request | ✓ | ✓ | ✓ | ✓* | |
| Warranty terms, extend / void warranties | ✓ | ✓ | | | |
| Receive bills into stock | ✓ | ✓ | ✓ | | |
| Record bills, confirm invoices, Zoho sync | ✓ | | ✓ | | |
| Draft invoices | ✓ | | ✓ | ✓ | |
| Stock levels, serial/warranty lookup | ✓ | ✓ | ✓ | ✓ | lookup only |
| Users, settings | ✓ | | | | |

\* via the API; the screen offers it to supervisor/accountant.

## Not built yet

Customer-facing warranty check page (QR), WhatsApp/SMS notices, van/transfer screens (the ledger supports
multiple locations), customer returns / credit notes, warranty transfer between owners, a Zoho **POS**
adapter, Excel/PDF report exports, viewing server photos offline.

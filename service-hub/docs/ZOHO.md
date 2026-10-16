# Zoho integration

Zoho remains the **books of record**. This app owns serial numbers, batches, warranty, service jobs and AMC
visits, and pushes accounting documents to Zoho as **drafts** for the accountant to review.

## What syncs

| Data | Direction | How |
|---|---|---|
| Taxes | Zoho → app | Pulled from the organisation's own tax setup. The app never hard-codes a rate or tax code. |
| Customers, vendors | Zoho → app | Name, phone, GSTIN, GST treatment, place of supply. Linked by Zoho contact id. |
| Items | Zoho → app | SKU, name, HSN/SAC, rate, tax, service/goods. Tracking mode is set once, locally. |
| Item warranty fields | Zoho custom fields → app | Read into warranty terms (see below). Edits made in the app are pushed back. |
| Sales invoices | app → Zoho | Created as **draft**. Carries `reference_number` = app number, warranty custom fields. |
| Purchase bills | app → Zoho | Created as **draft**, with the vendor's own bill number. |
| Invoice status / total | Zoho → app | Refreshed every sync; a total that differs from the app's preview is flagged. |

Pushes go through an **outbox** with idempotency keys. If a response is lost the next attempt finds the
draft by its reference number instead of creating a second one. Failures retry with backoff; problems that
need a person (e.g. customer not linked to Zoho) fail immediately and show on the *Zoho sync* page.

## Tax

The app follows the Zoho tax setup. Each line stores the Zoho `tax_id`; GST treatment and place of supply
are copied from the Zoho contact. Totals shown in the app are a **preview** — Zoho calculates the final
amounts and the app stores Zoho's total next to its own.

## ⚠️ Decisions needed before connecting

1. **Which Zoho organisation is this app for?** The connected account holds many organisations (your own
   firm and several client organisations). Nothing in this app is pointed at any of them yet — the
   organisation id is a setting (`ZOHO_ORG_ID`), and no data has been read or written in Zoho.
2. **Which Zoho product holds items, invoices and bills — Books (free) or POS (paid)?** The adapter in
   `api/src/zoho/client.ts` speaks the **Zoho Books API**. Zoho POS has its own API host and records;
   if POS is the system of record, a second adapter is needed (the rest of the app does not change).
3. **Custom fields on the free Books plan.** Zoho's published material suggests custom fields start on a
   paid Books plan, and the free plan has a 1,000 API-calls-per-day quota; third-party sources disagree on
   free-plan API access. This needs a one-line check against the real organisation before relying on it:
   - Zoho: [Books API call limits by plan](https://www.zoho.com/books/kb/automation/per-day-api-limit.html)
   - Zoho: [India plan comparison](https://www.zoho.com/in/books/pricing/pricing-comparison.html)

   If the chosen organisation cannot hold custom fields, the app still works: warranty terms live in the
   app, and the invoice carries the warranty wording in its **Notes/Terms** instead of custom fields.

## Custom fields to create in Zoho

None exist today. Create these (API names shown), then put their ids in `ZOHO_CUSTOM_FIELD_IDS`.

| Module | Label | API name | Type |
|---|---|---|---|
| Item | Warranty Template | `cf_warranty_template` | Text (the template **code**, e.g. `STD-1Y`) |
| Item | Warranty Parts Months | `cf_warranty_parts_months` | Number |
| Item | Warranty Labour Months | `cf_warranty_labour_months` | Number |
| Item | Warranty Onsite Months | `cf_warranty_onsite_months` | Number |
| Item | Warranty Terms | `cf_warranty_terms` | Multi-line text |
| Invoice | Warranty Start | `cf_warranty_start` | Date |
| Invoice | Warranty Terms | `cf_warranty_terms` | Multi-line text |
| Invoice | Serial Numbers | `cf_serial_numbers` | Multi-line text |
| Invoice | App Reference | `cf_app_ref` | Text |
| Bill | App Reference | `cf_app_ref` | Text |

`ZOHO_CUSTOM_FIELD_IDS` maps `"<module>.<api name>"` to the Zoho field id, for example:

```json
{"invoice.cf_warranty_start":"1234567000000012345","invoice.cf_warranty_terms":"1234567000000012346",
 "item.cf_warranty_template":"1234567000000012350"}
```

A field that is not in the map is simply skipped. **Warranty start is the invoice date** (your policy), so
`cf_warranty_start` always equals the invoice date; the per-unit end dates are in the app and in the
certificate. On the next item pull, any warranty values on a Zoho item become (or match) a warranty
template: by code if it exists, otherwise a template named from the month values is created.

## Connecting (India data centre)

1. Open <https://api-console.zoho.in>, create a **Self Client**.
2. Generate a grant code with scope `ZohoBooks.fullaccess.all` (tighten later to invoices, bills, contacts,
   items and settings once everything works), then exchange it for a **refresh token**.
3. Put `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` and `ZOHO_ORG_ID` in `.env`.
   The India endpoints are the defaults (`accounts.zoho.in`, `www.zohoapis.in`).
4. Restart the app, open **Zoho sync → Sync now**. Taxes, contacts and items are pulled; open invoices
   and bills then push on their own every minute.

The sync cycle uses a handful of API calls per minute at most; on a plan with a daily cap, raise
`ZOHO_SYNC_INTERVAL_SEC` (e.g. 300).

## Assumptions to verify on first connect

These were written from Zoho's published API shape and have not yet run against your organisation:

- Item custom fields arrive as `custom_field_hash` (keyed by API name) or a `custom_fields` array — both
  are handled (`api/src/zoho/mapper.ts`, unit-tested with sample payloads).
- Invoice/bill creation accepts `custom_fields: [{customfield_id, value}]`.
- Creating an invoice without a send/status flag leaves it as a draft.
- The `reference_number` filter on invoice/bill listing works for the duplicate check.

# Zoho integration (Zoho Books is the main system)

Zoho stays the **books of record**. This app owns serial numbers, batches, warranty, service jobs and AMC
visits. Sales invoices are pushed to Zoho as **drafts** for the accountant to review. Purchase bills are created
as **open** bills, because Zoho Books has no draft state for them; the app therefore posts a bill only when it is
received into stock.

`ZOHO_PRODUCT=books` is the default. `ZOHO_PRODUCT=pos` switches the same code to the Zoho POS (Zakya) API, in
case it is ever needed; see the end of this page.

## What syncs

| Data | Direction | How |
|---|---|---|
| Taxes | Zoho → app | Pulled from the organisation's own tax setup (GST groups and IGST). Nothing is hard-coded. |
| Customers, vendors | Zoho → app | Name, phone, GSTIN, GST treatment, place of supply. Linked by Zoho contact id. |
| Items | Zoho → app | Name, HSN/SAC, rate, **both** tax records (see below), goods/service, active. |
| Item warranty fields | Zoho custom fields → app | Read into warranty terms. Edits made in the app are written back. |
| Sales invoices | app → Zoho | Created as **draft**. `reference_number` = app number; warranty custom fields. |
| Purchase bills | app → Zoho | Created as an **open** bill with the vendor's own bill number, when received into stock. |
| Invoice status / total | Zoho → app | Refreshed every sync; a total that differs from the app's preview is flagged. |

Pushes go through an **outbox** with idempotency keys. If a response is lost, the next attempt finds the draft by
its reference number instead of creating a second one. Failures retry with backoff; problems that need a person
(e.g. a customer not linked to Zoho) fail at once and show on the *Zoho sync* page. A single bad record in a pull
(for example an item whose SKU is already used by another item) is skipped and reported; it never stops the rest.

Zoho's item **list** leaves out custom fields, so when warranty fields are configured the app reads full item
records with Zoho's **bulk** item-detail call, but only for items that are new or changed since the last sync.

## Tax

The app follows the Zoho tax setup. Each item carries two Zoho taxes: a GST tax group (same state) and an IGST tax
(other state). The app keeps both ids and, for every invoice line, chooses by place of supply: the customer's place
of supply equal to `HOME_PLACE_OF_SUPPLY` (your own state code as Zoho writes it) → GST; different → IGST. Set
`HOME_PLACE_OF_SUPPLY` (the organisation's state code; for Kerala it is `KL`), otherwise the app cannot tell and
always uses GST. Totals on screen are a preview (the rates are the same either way); Zoho calculates the final
amounts and the app stores Zoho's total next to its own and flags any difference.

## Checked against your Zoho Books organisation

Read-only, nothing written:

* The organisation is **GST-registered, state Kerala (KL)**, with SKU, locations and HSN/SAC enabled, and its plan
  shows as **"Zoho One Trial" (monthly)**. Make sure the subscription converts before the trial ends.
* Books, Inventory and POS in this Zoho One account **share the same master data**: item ids and tax ids returned
  by Books are identical to the ones POS returned. So Books as the main system loses nothing.
* Customers carry `place_of_contact` (e.g. `KL`) and GST treatment; taxes are GST and IGST at 0 / 5 / 12 / 18 / 28 / 40.

**Live pull**, using the app's own Zoho client and sync code against the real organisation into a scratch database:
12 taxes, 522 customers, 45 vendors and 710 items (546 active, 164 inactive; 10 services) all came in with **no
skipped records**; every item received both its GST and IGST tax; items without a SKU (most of them) use Zoho's item
id as the code; a second pull changed nothing. About 15 API calls read the custom fields of all 710 items.

## Custom fields (created in Zoho Books)

None existed; these ten **have been created** in the organisation, with the API names Zoho generated. That uses 3 of
the 5 multi-line fields.

| Module | Label | API name | Type |
|---|---|---|---|
| Item | Warranty Template (the template **code**, e.g. `STD-1Y`) | `cf_warranty_template` | Text (single line) |
| Item | Warranty Parts Months | `cf_warranty_parts_months` | Number |
| Item | Warranty Labour Months | `cf_warranty_labour_months` | Number |
| Item | Warranty Onsite Months | `cf_warranty_onsite_months` | Number |
| Item | Warranty Terms | `cf_warranty_terms` | Text (multi-line) |
| Invoice | Warranty Start | `cf_warranty_start` | Date |
| Invoice | Warranty Terms | `cf_warranty_terms` | Text (multi-line) |
| Invoice | Serial Numbers | `cf_serial_numbers` | Text (multi-line) |
| Invoice | App Reference | `cf_app_reference` | Text (single line) |
| Bill | App Reference | `cf_app_reference` | Text (single line) |

Put each field's Zoho id in `ZOHO_CUSTOM_FIELD_IDS`. The keys are the app's own names, `"<module>.<name>"`; the
reference field's key is `cf_app_ref` even though Zoho's API name is `cf_app_reference`:

```json
{"invoice.cf_warranty_start":"<field id>","invoice.cf_warranty_terms":"<field id>",
 "invoice.cf_serial_numbers":"<field id>","invoice.cf_app_ref":"<field id>","bill.cf_app_ref":"<field id>",
 "item.cf_warranty_template":"<field id>","item.cf_warranty_parts_months":"<field id>",
 "item.cf_warranty_labour_months":"<field id>","item.cf_warranty_onsite_months":"<field id>",
 "item.cf_warranty_terms":"<field id>"}
```

A field that is not in the map is skipped. **Warranty start is the invoice date**, so `cf_warranty_start` always equals
the invoice date; per-unit end dates are in the app and on the certificate. On each item pull, warranty values on a
Zoho item become (or match) a warranty template: by code if it exists, otherwise a template named from the month
values is created.

Zoho does **not** print multi-line custom fields on the invoice PDF (`can_show_in_pdf` is false for them), so the
per-unit warranty wording and serial numbers are stored on the invoice but do not appear on the printed copy; the
single-line and date fields can.

## Connecting (India data centre)

The simplest way needs only a **Client ID and Client Secret** (no refresh token, no grant code):

1. Open <https://api-console.zoho.in> and create a **Self Client**.
2. Put `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_ORG_ID` (your Books organisation id), `HOME_PLACE_OF_SUPPLY`
   and `ZOHO_CUSTOM_FIELD_IDS` in the server's `.env`. Leave `ZOHO_REFRESH_TOKEN` blank. The app then asks Zoho for a
   fresh one-hour token whenever it needs one (the "client credentials" flow), scoped to your organisation. If you
   prefer a refresh token, set `ZOHO_REFRESH_TOKEN` and it is used instead.
3. The default scope is deliberately narrow: `ZohoBooks.settings.READ`, `ZohoBooks.settings.UPDATE`,
   `ZohoBooks.contacts.READ`, `ZohoBooks.invoices.CREATE`, `ZohoBooks.invoices.READ`, `ZohoBooks.bills.CREATE`,
   `ZohoBooks.bills.READ` (override with `ZOHO_SCOPE`). Reading taxes, items and contacts was confirmed to work with
   `settings.READ` and `contacts.READ` alone; Zoho accepts the full list.
4. Restart, then **Zoho sync → Sync now**. Taxes, contacts and items are pulled; confirmed invoices and bills then
   push on their own every minute. On a plan with a daily API cap, raise `ZOHO_SYNC_INTERVAL_SEC` (e.g. 300).

**Treat the Client Secret like a password.** Keep it only in the server's `.env`. If it has been pasted into a chat
or email, generate a new one in the API console and replace it.

## Decisions still needed

1. **Who owns quantity on hand?** Recommended: **Zoho owns quantities and prices; this app owns serial numbers,
   batches and warranty.** The app deducts stock when an invoice is *confirmed*; Zoho deducts when the draft is
   *sent*, so the two can differ for a short while. A stock-variance report against Zoho's quantity is the next
   thing to build.
2. **Serial/batch tracking inside Zoho.** Left off, as now, Zoho never asks for serial numbers on the draft. Books
   *can* also record serial/batch numbers on invoice lines ("advanced tracking"); if you want Zoho to hold them too,
   the app can send them with the draft invoice.

## Verified live with a real write

One test invoice and one test bill were created in the organisation through the app's own payload builders, using
the narrow default scope, then read back and **deleted** (confirmed gone). The invoice used its own test number, so
the real invoice number series was not touched. Confirmed:

* A sales invoice is created as a **draft**, with `reference_number` = the app number, the right same-state tax
  (GST18) chosen for the line, and all four warranty custom fields stored.
* The duplicate check by `reference_number` finds the created invoice and bill.
* A bill is created as **open** (not draft) and carries its custom field.
* Zoho may **round the invoice total to a whole rupee** (a ₹0.41 invoice came back with total 0, subtotal and tax
  correct), so the app compares subtotal and tax strictly and allows 50 paise on the total.

Still unconfirmed: item custom-field **write-back** (`PUT /items/{id}` with `custom_fields`), which changes a real
item and was not tested.

## If Zoho POS is ever used directly

`ZOHO_PRODUCT=pos` uses `https://api.zakya.in/inventory/v1/...` (`ZOHO_POS_API_URL`), POS scopes
(`ZohoPOSAPI.items.READ`, `ZohoPOSAPI.invoices.CREATE`, `ZohoPOSAPI.bills.CREATE`, …), writes invoice custom fields as
`{index, label, value}` (map them as `{"index":1,"label":"Warranty Start"}`), and always sends a due date on bills.
See Zoho's POS API docs: [invoices](https://www.zoho.com/pos/resources/api/invoices.html),
[items](https://www.zoho.com/pos/resources/api/items.html), [bills](https://www.zoho.com/pos/resources/api/bills.html).

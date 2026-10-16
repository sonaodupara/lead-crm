# Zoho integration (Zoho POS first, Books supported)

Zoho stays the **books of record**. This app owns serial numbers, batches, warranty, service jobs and AMC
visits, and pushes accounting documents to Zoho as **drafts** for the accountant to review.

The Zoho layer talks to **Zoho POS** by default (`ZOHO_PRODUCT=pos`). Set `ZOHO_PRODUCT=books` to use the
Zoho Books API instead; resource names are the same, only the host, prefix and a few list filters differ.

## What syncs

| Data | Direction | How |
|---|---|---|
| Taxes | Zoho → app | Pulled from the organisation's own tax setup (GST groups and IGST). Nothing is hard-coded. |
| Customers, vendors | Zoho → app | Name, phone, GSTIN, GST treatment, place of supply. Linked by Zoho contact id. |
| Items | Zoho → app | Name, HSN/SAC, rate, **both** tax records (see below), goods/service, active. |
| Item warranty fields | Zoho custom fields → app | Read into warranty terms (see below). Edits made in the app are pushed back. |
| Sales invoices | app → Zoho | Created as **draft**. `reference_number` = app number; warranty custom fields if configured. |
| Purchase bills | app → Zoho | Created as **draft**, with the vendor's own bill number and a due date (POS requires one). |
| Invoice status / total | Zoho → app | Refreshed every sync; a total that differs from the app's preview is flagged. |

Pushes go through an **outbox** with idempotency keys. If a response is lost, the next attempt finds the
draft by its reference number instead of creating a second one. Failures retry with backoff; problems that
need a person (e.g. a customer not linked to Zoho) fail at once and show on the *Zoho sync* page.

## Tax

The app follows the Zoho tax setup. Zoho POS gives every item **two** tax records: a GST tax group
(same state) and an IGST tax (other state). The app keeps both ids, and for each invoice line chooses by place
of supply: the customer's place of supply equal to `HOME_PLACE_OF_SUPPLY` (your own state code as Zoho writes
it, e.g. `KL`) → GST; different → IGST. If `HOME_PLACE_OF_SUPPLY` is blank the app cannot tell and uses GST,
so **set it**. Totals on screen are a preview (the rates are the same either way); Zoho calculates the final
amounts and the app stores Zoho's total next to its own and flags any difference.

## Checked against your organisation (read-only, nothing written)

Against the organisation you named (a paid POS plan):

* Taxes list works: GST and IGST at 0 / 5 / 12 / 18 / 28 / 40 — pulled as they are.
* Items list works. Items have **no SKU** (the app falls back to part number, then Zoho's item id), some are
  inactive, and **serial and batch tracking are switched off** on every item sampled.
* Zoho POS tracks **stock on hand** itself.
* The connected token is **not authorised to list custom fields** (Zoho error 57), so none could be read or
  created from here. Create them in the POS screens (below).

## ⚠️ Decisions still needed

1. **Confirm the organisation id.** The number given for Zoho turned out to be the id in an organisation's
   logo link, not the organisation id itself. The checks above used the organisation that link belongs to; the
   app uses whatever is in `ZOHO_ORG_ID`. Check the id in the Zoho POS URL or *Settings → Organisation* before
   going live.
2. **Who owns quantity on hand?** Recommended: **Zoho POS owns quantities and prices; this app owns serial
   numbers, batches and warranty.** Keep serial/batch tracking **off in POS** for these items: the app sends
   draft invoices without serial numbers (POS documents no serial field on invoice lines), and POS would
   otherwise ask for them. The app deducts stock when an invoice is *confirmed* while POS deducts when the draft
   is *sent*, so the two can differ for a short while; a stock-variance report using POS's quantity is the
   next thing to build.
3. **Custom fields.** None exist yet. Create them in POS (list below). If you would rather not, warranty
   wording can travel in the invoice notes instead.

## Custom fields to create in Zoho POS

| Module | Label | Type |
|---|---|---|
| Item | Warranty Template (the template **code**, e.g. `STD-1Y`) | Text |
| Item | Warranty Parts Months / Warranty Labour Months / Warranty Onsite Months | Number |
| Item | Warranty Terms | Multi-line text |
| Invoice | Warranty Start | Date |
| Invoice | Warranty Terms | Multi-line text |
| Invoice | Serial Numbers | Multi-line text |
| Invoice | App Reference | Text |

Then map them in `ZOHO_CUSTOM_FIELD_IDS`. For **POS**, an invoice custom field is identified by its slot
`index` and `label` (as the POS API takes it):

```json
{"invoice.cf_warranty_start":{"index":1,"label":"Warranty Start"},
 "invoice.cf_warranty_terms":{"index":2,"label":"Warranty Terms"},
 "item.cf_warranty_template":"<customfield_id from the item response>"}
```

(Books uses plain ids: `"invoice.cf_warranty_start":"1234567000000012345"`.) A field not in the map is skipped.
**Warranty start is the invoice date**, so `cf_warranty_start` always equals the invoice date; per-unit end
dates are in the app and on the certificate. On each item pull, warranty values on a Zoho item become (or match)
a warranty template: by code if it exists, otherwise a template named from the month values is created.

## Connecting (India data centre)

1. Open <https://api-console.zoho.in> and create a **Self Client**.
2. Generate a grant code with these scopes, exchange it for a **refresh token**:
   `ZohoPOSAPI.taxes.READ, ZohoPOSAPI.contacts.READ, ZohoPOSAPI.items.READ, ZohoPOSAPI.items.UPDATE,
   ZohoPOSAPI.invoices.CREATE, ZohoPOSAPI.invoices.READ, ZohoPOSAPI.bills.CREATE, ZohoPOSAPI.bills.READ`
   (scope names are from Zoho's POS API documentation).
3. Put `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORG_ID` (your organisation id) and
   `HOME_PLACE_OF_SUPPLY` in `.env`. Defaults: `ZOHO_PRODUCT=pos`, `ZOHO_POS_API_URL=https://api.zakya.in`.
4. Restart, then **Zoho sync → Sync now**. Taxes, contacts and items are pulled; confirmed invoices and bills
   then push on their own every minute.

Sources: [Zoho POS API — invoices](https://www.zoho.com/pos/resources/api/invoices.html),
[items](https://www.zoho.com/pos/resources/api/items.html), [taxes](https://www.zoho.com/pos/resources/api/taxes.html),
[contacts](https://www.zoho.com/pos/resources/api/contacts.html), [bills](https://www.zoho.com/pos/resources/api/bills.html).

## Not verified yet — first connect will tell

These come from Zoho's documentation or from reads above, not from a live write:

* The India host `https://api.zakya.in` (the docs say to swap `.com` for your domain; it is a setting).
* A POS **item custom-field update**: the docs show two different paths; the app uses `PUT /items/{id}` with
  `custom_fields`. If Zoho rejects it, the *Zoho sync* page shows the error and only the item-field write-back fails.
* A POS **bill** line identifies its item by `item_id` (the bill page does not list it explicitly).
* POS bills do not document custom fields; the bill's `reference_number` carries the app number instead.
* The default status of a POS bill created through the API (invoices are documented as draft).
* Item custom fields arrive as `custom_field_hash` or a `custom_fields` array — both are handled.

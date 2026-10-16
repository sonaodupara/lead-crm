import { config } from '../config.js';

const apiBase = () => (config.ZOHO_PRODUCT === 'pos' ? `${config.ZOHO_POS_API_URL}/inventory/v1` : config.ZOHO_BOOKS_API_URL);

export class ZohoError extends Error {
  constructor(message: string, public status: number, public zohoCode?: number, public retryable = false) {
    super(message);
  }
}

/** The slice of the Zoho Books API the app uses. Tests and local dev swap in a fake. */
export interface ZohoApi {
  listTaxes(): Promise<any[]>;
  listContacts(type: 'customer' | 'vendor', page: number): Promise<{ rows: any[]; hasMore: boolean }>;
  listItems(page: number): Promise<{ rows: any[]; hasMore: boolean }>;
  getItem(id: string): Promise<any>;
  /** Bulk read of full item records (custom fields, tracking flags) — one call for many items. */
  getItems(ids: string[]): Promise<any[]>;
  updateItemCustomFields(id: string, fields: object[]): Promise<void>;
  findInvoiceByReference(ref: string): Promise<any | null>;
  createInvoice(payload: object): Promise<any>;
  getInvoice(id: string): Promise<any>;
  findBillByReference(ref: string): Promise<any | null>;
  createBill(payload: object): Promise<any>;
  getBill(id: string): Promise<any>;
}

/** Zoho REST client for Books or POS (same resource names; different host, prefix and a few list filters). */
export class ZohoClient implements ZohoApi {
  private token: { value: string; expires: number } | null = null;

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const body = config.ZOHO_REFRESH_TOKEN
      ? new URLSearchParams({ refresh_token: config.ZOHO_REFRESH_TOKEN, client_id: config.ZOHO_CLIENT_ID, client_secret: config.ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' })
      : new URLSearchParams({
          client_id: config.ZOHO_CLIENT_ID, client_secret: config.ZOHO_CLIENT_SECRET, grant_type: 'client_credentials', scope: config.ZOHO_SCOPE,
          soid: config.ZOHO_SOID || `${config.ZOHO_PRODUCT === 'books' ? 'ZohoBooks' : 'ZohoPOS'}.${config.ZOHO_ORG_ID}`,
        });
    const res = await fetch(`${config.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, { method: 'POST', body });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token)
      throw new ZohoError(`Zoho token refresh failed: ${json.error ?? res.status}`, res.status, undefined, res.status >= 500);
    this.token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async req(method: string, path: string, opts: { query?: Record<string, string | number>; body?: object } = {}, retry = true): Promise<any> {
    const url = new URL(apiBase() + path);
    url.searchParams.set('organization_id', config.ZOHO_ORG_ID);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Zoho-oauthtoken ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401 && retry) { await this.accessToken(true); return this.req(method, path, opts, false); }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || (json.code !== undefined && json.code !== 0))
      throw new ZohoError(`Zoho ${method} ${path}: ${json.message ?? res.status}`, res.status, json.code,
        res.status === 429 || res.status >= 500);
    return json;
  }

  async listTaxes() { return (await this.req('GET', '/settings/taxes')).taxes ?? []; }
  async listContacts(type: 'customer' | 'vendor', page: number) {
    // Books filters by contact_type. POS documents no such filter, so it returns both and we pick by each row's contact_type.
    const pos = config.ZOHO_PRODUCT === 'pos';
    const j = await this.req('GET', '/contacts', { query: pos ? { filter_by: 'Status.All', page, per_page: 200 } : { contact_type: type, page, per_page: 200 } });
    const rows: any[] = j.contacts ?? [];
    return { rows: pos ? rows.filter((r) => !r.contact_type || r.contact_type === type) : rows, hasMore: Boolean(j.page_context?.has_more_page) };
  }
  async listItems(page: number) {
    const j = await this.req('GET', '/items', { query: { page, per_page: 200, filter_by: 'Status.All' } });   // include inactive so deactivations reach the app
    return { rows: j.items ?? [], hasMore: Boolean(j.page_context?.has_more_page) };
  }
  async getItem(id: string) { return (await this.req('GET', `/items/${id}`)).item; }
  async getItems(ids: string[]) {
    if (!ids.length) return [];
    return (await this.req('GET', '/itemdetails', { query: { item_ids: ids.join(',') } })).items ?? [];
  }
  async updateItemCustomFields(id: string, fields: object[]) {
    await this.req('PUT', `/items/${id}`, { body: { custom_fields: fields } });
  }
  async findInvoiceByReference(ref: string) {
    const j = await this.req('GET', '/invoices', { query: { reference_number: ref } });
    return (j.invoices ?? []).find((i: any) => i.reference_number === ref) ?? null;
  }
  async createInvoice(payload: object) { return (await this.req('POST', '/invoices', { body: payload })).invoice; }
  async getInvoice(id: string) { return (await this.req('GET', `/invoices/${id}`)).invoice; }
  async findBillByReference(ref: string) {
    const j = await this.req('GET', '/bills', { query: { reference_number: ref } });
    return (j.bills ?? []).find((b: any) => b.reference_number === ref) ?? null;
  }
  async createBill(payload: object) { return (await this.req('POST', '/bills', { body: payload })).bill; }
  async getBill(id: string) { return (await this.req('GET', `/bills/${id}`)).bill; }
}

/** Back-compat name used by older imports. */
export const ZohoBooksClient = ZohoClient;

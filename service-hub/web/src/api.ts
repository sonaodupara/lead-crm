const TOKEN_KEY = 'sh_token';

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t: string | null) => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) { super(message); }
}
/** Thrown when the request never reached the server (offline, DNS, timeout). */
export class NetworkError extends Error {
  constructor() { super('No connection to the server'); }
}

async function parse(res: Response) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

async function send(method: string, path: string, body?: unknown, form?: FormData) {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new NetworkError();
  }
  const data = await parse(res);
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event('auth:expired'));
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, data?.details);
  }
  return data;
}

export const api = {
  get: <T = any>(path: string) => send('GET', path) as Promise<T>,
  post: <T = any>(path: string, body?: unknown) => send('POST', path, body ?? {}) as Promise<T>,
  put: <T = any>(path: string, body?: unknown) => send('PUT', path, body ?? {}) as Promise<T>,
  patch: <T = any>(path: string, body?: unknown) => send('PATCH', path, body ?? {}) as Promise<T>,
  del: <T = any>(path: string) => send('DELETE', path) as Promise<T>,
  upload: <T = any>(path: string, form: FormData) => send('POST', path, undefined, form) as Promise<T>,
};

export const qs = (o: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Fetch an authenticated file (certificate, photo, bill scan) and open it in a new tab. */
export async function openProtected(path: string) {
  let res: Response;
  try { res = await fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } }); } catch { throw new NetworkError(); }
  if (!res.ok) throw new ApiError(res.status, 'Could not open the file');
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function fetchBlobUrl(path: string): Promise<string> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new ApiError(res.status, 'Could not load the file');
  return URL.createObjectURL(await res.blob());
}

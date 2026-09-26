// API client for the RemoteOps console.
//
// The access token lives in module memory only (`let token`). It is never
// written to localStorage, sessionStorage, or a readable cookie, so a second
// tab cannot inherit it and a reload must go through the refresh cookie.
// Every permission decision the UI makes comes from the `permissions` maps
// the server returns — there is no role matrix here.

// In-memory bearer token. Module scope = per-tab memory.
let token = null;

const BASE = '/v1';

async function request(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'include', // refresh cookie is HttpOnly, Path=/v1/auth
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = data && data.error ? data.error : {};
    throw {
      status: res.status,
      code: err.code || 'UNKNOWN',
      message: err.message || `request failed (${res.status})`,
      reason: err.reason || null,
    };
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body === undefined ? {} : body),
  patch: (path, body) => request('PATCH', path, body === undefined ? {} : body),
  del: (path) => request('DELETE', path),

  async login(email, password) {
    const data = await request('POST', '/auth/login', { email, password });
    if (data && data.token) token = data.token;
    return data;
  },

  // Returns null when there is simply no session (401). Anything else is
  // a real failure and is rethrown so the boot path can surface it.
  async refresh() {
    try {
      const data = await request('POST', '/auth/refresh', {});
      if (data && data.token) token = data.token;
      return data;
    } catch (err) {
      if (err && err.status === 401) return null;
      throw err;
    }
  },

  // Mint a token for another org the caller already belongs to.
  async switchOrg(orgId) {
    const data = await request('POST', '/auth/token', { orgId });
    if (data && data.token) token = data.token;
    return data;
  },

  logout() {
    token = null;
  },

  me() {
    return request('GET', '/auth/me');
  },
};

// The only presence check the console performs: did the server resolve
// this permission to `allow` for the relevant scope?
export function isAllowed(perms, key) {
  return perms != null && perms[key] != null && perms[key].effect === 'allow';
}

// Human-readable failure text. Always the server's message, so a wrong
// password and an unknown account read identically (no enumeration oracle).
export function describeError(err) {
  if (!err) return 'request failed';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  return 'request failed';
}

// Machine reason behind a non-allow entry (audit-style reason code).
export function whyLocked(entry) {
  if (!entry) return 'missing_permission';
  if (entry.effect === 'allow') return null;
  return entry.reason || 'missing_permission';
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

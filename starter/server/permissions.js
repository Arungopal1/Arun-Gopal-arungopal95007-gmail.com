// Permission resolution — the single place allow/deny is decided.
//
// Reads everything from the database at request time: the catalogue from
// `permissions`, baselines from `role_permissions`, deltas from `grants` +
// `grant_permissions`. No role matrix lives here as a literal, so an
// undocumented role/permission from the personalised overlay resolves the
// same way as the documented 19.

import { forbidden } from './http.js';

export const MODE_PERMISSION = {
  view: 'device:view',
  control: 'device:control',
  terminal: 'device:terminal',
};

// Expand one grant pattern against the live catalogue.
function expandPattern(pattern, catalogue) {
  if (pattern === '*') return catalogue;
  if (pattern.endsWith(':*')) {
    const stem = pattern.slice(0, -1);
    return catalogue.filter((k) => k.startsWith(stem));
  }
  return catalogue.includes(pattern) ? [pattern] : [];
}

// Fetch grants that could apply. deviceId=null means the org-level union
// (every grant counts, even device-scoped ones — for nav gating).
// Otherwise org-wide grants plus grants pinned to that device.
function fetchGrants(db, { userId, orgId, deviceId, at }) {
  const base = `SELECT g.id AS gid, g.device_id AS scope, g.effect, gp.permission AS pattern
    FROM grants g JOIN grant_permissions gp ON gp.grant_id = g.id
    WHERE g.user_id = ? AND g.org_id = ? AND g.revoked_at IS NULL
    AND (g.starts_at IS NULL OR g.starts_at <= ?)
    AND (g.expires_at IS NULL OR g.expires_at > ?)`;
  if (deviceId === null || deviceId === undefined) {
    return db.prepare(base).all(userId, orgId, at, at);
  }
  return db.prepare(`${base} AND (g.device_id IS NULL OR g.device_id = ?)`)
    .all(userId, orgId, at, at, deviceId);
}

function emptySet(catalogue, role, reason) {
  const permissions = {};
  for (const key of catalogue) permissions[key] = { effect: 'deny', source: null, reason };
  return { role, permissions };
}

// Core combine: deny set first (wins unconditionally), then baseline + allows.
function combine({ catalogue, role, baseline, rows }) {
  const deniedBy = new Map();
  const allowedBy = new Map();
  for (const r of rows) {
    if (r.effect !== 'deny') continue;
    for (const key of expandPattern(r.pattern, catalogue)) {
      if (!deniedBy.has(key)) deniedBy.set(key, r.gid);
    }
  }
  for (const key of baseline) allowedBy.set(key, `role:${role}`);
  for (const r of rows) {
    if (r.effect !== 'allow') continue;
    for (const key of expandPattern(r.pattern, catalogue)) {
      if (!allowedBy.has(key)) allowedBy.set(key, `grant:${r.gid}`);
    }
  }
  const permissions = {};
  for (const key of catalogue) {
    if (deniedBy.has(key)) {
      permissions[key] = { effect: 'deny', source: `grant:${deniedBy.get(key)}`, reason: 'explicit_deny' };
    } else if (allowedBy.has(key)) {
      permissions[key] = { effect: 'allow', source: allowedBy.get(key), reason: null };
    } else {
      permissions[key] = { effect: 'deny', source: null, reason: 'implicit' };
    }
  }
  return permissions;
}

export function resolve(db, { userId, orgId, deviceId = null, now = new Date() }) {
  const at = now.toISOString();
  const catalogue = db.prepare('SELECT key FROM permissions').all().map((r) => r.key);
  const mem = db.prepare('SELECT role, status FROM memberships WHERE org_id = ? AND user_id = ?')
    .get(orgId, userId);
  if (!mem) return emptySet(catalogue, null, 'not_a_member');
  if (mem.status === 'suspended') return emptySet(catalogue, mem.role, 'suspended');
  if (mem.status !== 'active') return emptySet(catalogue, mem.role, 'inactive_membership');
  const baseline = new Set(
    db.prepare('SELECT permission FROM role_permissions WHERE role = ?').all(mem.role)
      .map((r) => r.permission)
  );
  const rows = fetchGrants(db, { userId, orgId, deviceId, at });
  return { role: mem.role, permissions: combine({ catalogue, role: mem.role, baseline, rows }) };
}

export function resolveDevices(db, { userId, orgId, deviceIds, now = new Date() }) {
  const at = now.toISOString();
  const catalogue = db.prepare('SELECT key FROM permissions').all().map((r) => r.key);
  const mem = db.prepare('SELECT role, status FROM memberships WHERE org_id = ? AND user_id = ?')
    .get(orgId, userId);
  const role = mem?.role ?? null;
  const blocked = !mem ? 'not_a_member' : mem.status === 'suspended' ? 'suspended'
    : mem.status !== 'active' ? 'inactive_membership' : null;
  if (blocked) {
    const { permissions } = emptySet(catalogue, role, blocked);
    const byDevice = {};
    for (const id of deviceIds) byDevice[id] = permissions;
    return { role, byDevice };
  }
  const baseline = new Set(
    db.prepare('SELECT permission FROM role_permissions WHERE role = ?').all(role)
      .map((r) => r.permission)
  );
  const all = fetchGrants(db, { userId, orgId, deviceId: null, at });
  const byDevice = {};
  for (const id of deviceIds) {
    const rows = all.filter((r) => r.scope === null || r.scope === id);
    byDevice[id] = combine({ catalogue, role, baseline, rows });
  }
  return { role, byDevice };
}

export function can(db, ctx, permission, deviceId) {
  const out = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });
  return out.permissions[permission]?.effect === 'allow';
}

export function assertCan(db, ctx, permission, deviceId) {
  const out = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });
  const entry = out.permissions[permission];
  if (entry?.effect === 'allow') return;
  const map = {
    explicit_deny: 'explicit_deny',
    suspended: 'suspended',
    not_a_member: 'not_a_member',
    inactive_membership: 'not_a_member',
    implicit: 'missing_permission',
  };
  throw forbidden(`missing permission: ${permission}`, map[entry?.reason] ?? 'missing_permission');
}

export function assertMayGrant(db, ctx, patterns, deviceId = null) {
  const out = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });
  const catalogue = Object.keys(out.permissions);
  for (const pattern of patterns) {
    for (const key of expandPattern(pattern, catalogue)) {
      if (out.permissions[key]?.effect === 'allow') continue;
      throw forbidden(
        `you cannot grant a permission you do not hold at this scope: ${key}`,
        out.permissions[key]?.reason === 'explicit_deny' ? 'explicit_deny' : 'missing_permission'
      );
    }
  }
}

export function assertCanStartSession(db, ctx, mode, deviceId) {
  const need = MODE_PERMISSION[mode];
  if (!need) throw forbidden('unknown session mode', 'validation');
  assertCan(db, ctx, 'session:start', deviceId);
  const out = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });
  if (out.permissions[need]?.effect !== 'allow') {
    throw forbidden(`${mode} sessions also require ${need}`, 'missing_device_permission');
  }
}

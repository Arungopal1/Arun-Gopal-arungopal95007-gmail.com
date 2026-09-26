// Shared domain rules used by more than one route: ranks, last-owner, sessions.

import { newId, nowIso } from './db.js';
import { badRequest, forbidden, lastOwner } from './http.js';

export function roleRanks(db) {
  const rows = db.prepare('SELECT key, rank FROM roles').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.rank]));
}

export function assertRoleExists(db, role) {
  const row = db.prepare('SELECT key FROM roles WHERE key = ?').get(role);
  if (!row) throw badRequest(`unknown role: ${role}`, 'unknown_role');
}

export function assertCanModify(db, callerRole, targetRole) {
  if (callerRole === 'owner') return;
  const ranks = roleRanks(db);
  if (ranks[callerRole] > ranks[targetRole]) return;
  throw forbidden('you cannot modify a user at or above your own role', 'insufficient_rank');
}

export function assertNotLastOwner(db, orgId, userId) {
  const target = db.prepare('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?')
    .get(orgId, userId);
  if (target?.role !== 'owner') return;
  const owners = db.prepare(
    `SELECT count(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'`
  ).get(orgId).n;
  if (owners <= 1) throw lastOwner();
}

export function endActiveSessions(db, { orgId, userId, deviceId = null, reason, exceptSessionId = null }) {
  const clauses = ['org_id = ?', "state = 'active'"];
  const args = [orgId];
  if (userId) { clauses.push('user_id = ?'); args.push(userId); }
  if (deviceId) { clauses.push('device_id = ?'); args.push(deviceId); }
  if (exceptSessionId) { clauses.push('id != ?'); args.push(exceptSessionId); }
  const ids = db.prepare(`SELECT id FROM sessions WHERE ${clauses.join(' AND ')}`)
    .all(...args).map((r) => r.id);
  if (ids.length === 0) return [];
  const at = nowIso();
  const upd = db.prepare(`UPDATE sessions SET state = 'ended', ended_at = ?, end_reason = ? WHERE id = ?`);
  for (const id of ids) upd.run(at, reason, id);
  return ids;
}

export function snapshotAuthority(db, { userId, orgId, deviceId }) {
  const role = db.prepare('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?')
    .get(orgId, userId)?.role ?? null;
  const at = nowIso();
  const grantIds = db.prepare(
    `SELECT g.id FROM grants g WHERE g.user_id = ? AND g.org_id = ? AND g.revoked_at IS NULL
     AND (g.starts_at IS NULL OR g.starts_at <= ?) AND (g.expires_at IS NULL OR g.expires_at > ?)
     AND (g.device_id IS NULL OR g.device_id = ?)`
  ).all(userId, orgId, at, at, deviceId).map((r) => r.id);
  return JSON.stringify({ role, grantIds, snapshotAt: at });
}

export function sessionExpiry(db, orgId) {
  const minutes = db.prepare('SELECT max_session_minutes AS m FROM organizations WHERE id = ?')
    .get(orgId)?.m ?? 60;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export { newId, nowIso };

// Caller context: bearer token -> { userId, orgId, role, membership, claims }.
//
// The token's org claim is the only org the caller may address. Anything naming
// a different org is invisible (404), never forbidden — isolation is structural.

import { verifyAccessToken, assertFresh } from './auth.js';
import { unauthenticated, notFound } from './http.js';

export function authenticate(db, secret) {
  return function buildContext(req, params) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthenticated('missing bearer token');
    const claims = verifyAccessToken(token, secret);

    const membership = db.prepare(
      `SELECT m.*, o.deleted_at AS org_gone FROM memberships m
       JOIN organizations o ON o.id = m.org_id
       WHERE m.org_id = ? AND m.user_id = ?`
    ).get(claims.org, claims.sub);

    if (!membership) throw unauthenticated('not a member of this org');
    if (membership.org_gone) throw notFound();
    if (membership.status === 'removed') throw unauthenticated('membership removed');
    // Suspended callers keep a verifiable token but resolve to an empty set, so
    // the refusal is 403 suspended — not 401 stale. Skip freshness only here.
    if (membership.status !== 'suspended') assertFresh(claims, membership);
    if (params.org && params.org !== claims.org) throw notFound();

    return {
      userId: claims.sub,
      orgId: claims.org,
      role: membership.role,
      membership,
      claims,
    };
  };
}

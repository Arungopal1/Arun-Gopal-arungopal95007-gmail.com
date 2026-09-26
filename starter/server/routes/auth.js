// Auth routes: login, org switch, refresh rotation, and self profile.
//
// Login and refresh are public (cookie / credentials); token switch and me
// run behind the bearer context built in ../context.js.

import { newId, nowIso } from '../db.js';
import { send, badRequest, unauthenticated, forbidden, notFound } from '../http.js';
import {
  issueAccessToken,
  verifyPassword,
  newRefreshToken,
  hashRefreshToken,
  REFRESH_TTL_SECONDS,
  ACCESS_TTL_SECONDS,
} from '../auth.js';
import { resolve } from '../permissions.js';
import { audit } from '../audit.js';

// Active orgs for a user, ordered for deterministic default selection.
// Only counts memberships that are usable right now in a live org.
function membershipsOf(db, userId) {
  return db
    .prepare(
      `SELECT o.id AS id, o.name AS name, o.theme AS theme,
              m.role AS role, m.perm_version AS perm_version
         FROM memberships m
         JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL
        ORDER BY o.name`
    )
    .all(userId);
}

// Keep the public org list small and stable for clients.
function publicOrgs(rows) {
  return rows.map((r) => ({ id: r.id, name: r.name, theme: r.theme, role: r.role }));
}

// Refresh cookie is scoped so browsers only send it back to auth endpoints.
function setRefreshCookie(res, raw) {
  res.setHeader(
    'set-cookie',
    `rt=${raw}; HttpOnly; SameSite=Strict; Path=/v1/auth; Max-Age=${REFRESH_TTL_SECONDS}`
  );
}

// Pull the raw `rt` value out of a Cookie header, tolerating extra cookies.
function readRefreshCookie(req) {
  const header = req?.headers?.cookie;
  if (!header || typeof header !== 'string') return null;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === 'rt') return part.slice(eq + 1).trim();
  }
  return null;
}

// Fresh expiry timestamp for a newly minted refresh row.
function refreshExpiry() {
  return new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString();
}

export function register(router, { db, secret }) {
  // POST /v1/auth/login — public, credential based.
  router.post('/v1/auth/login', async (ctx, _params, res) => {
    const body = ctx.body ?? {};
    const { email, password, orgId } = body;

    if (typeof email !== 'string' || typeof password !== 'string') {
      throw badRequest('email and password are required');
    }
    const normalized = email.trim().toLowerCase();

    const user = db
      .prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?')
      .get(normalized);

    if (!user || !verifyPassword(password, user.password_hash)) {
      // Identical message either way so callers cannot enumerate accounts.
      // When we know who tried, leave a deny trail against one of their orgs
      // (audit needs a non-null org).
      if (user) {
        const probe = db
          .prepare(
            `SELECT o.id AS id
               FROM memberships m
               JOIN organizations o ON o.id = m.org_id
              WHERE m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL
              ORDER BY o.name LIMIT 1`
          )
          .get(user.id);
        if (probe) {
          audit(db, {
            orgId: probe.id,
            actorId: user.id,
            action: 'auth.login',
            result: 'deny',
            reasonCode: 'invalid_credentials',
            requestId: ctx.requestId,
          });
        }
      }
      throw unauthenticated('invalid email or password');
    }

    const orgs = membershipsOf(db, user.id);
    if (orgs.length === 0) throw forbidden('no active memberships');

    let active;
    if (orgId) {
      active = orgs.find((o) => o.id === orgId);
      if (!active) throw notFound();
    } else {
      active = orgs[0];
    }

    const token = issueAccessToken(
      { userId: user.id, orgId: active.id, role: active.role, permVersion: active.perm_version },
      secret
    );

    const raw = newRefreshToken();
    db.prepare(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(newId('rft'), user.id, hashRefreshToken(raw), newId('rtf'), refreshExpiry());
    setRefreshCookie(res, raw);

    audit(db, {
      orgId: active.id,
      actorId: user.id,
      action: 'auth.login',
      result: 'allow',
      requestId: ctx.requestId,
    });

    send(res, 200, {
      token,
      expiresIn: ACCESS_TTL_SECONDS,
      user: { id: user.id, email: user.email, name: user.name },
      orgId: active.id,
      role: active.role,
      orgs: publicOrgs(orgs),
    });
  });

  // POST /v1/auth/token — authenticated, mint a token for another member org.
  router.post('/v1/auth/token', async (ctx, _params, res) => {
    const { orgId } = ctx.body ?? {};
    if (typeof orgId !== 'string' || orgId.length === 0) {
      throw badRequest('orgId is required');
    }

    const orgs = membershipsOf(db, ctx.userId);
    const active = orgs.find((o) => o.id === orgId);
    if (!active) throw notFound();

    const token = issueAccessToken(
      { userId: ctx.userId, orgId: active.id, role: active.role, permVersion: active.perm_version },
      secret
    );

    send(res, 200, {
      token,
      expiresIn: ACCESS_TTL_SECONDS,
      orgId: active.id,
      role: active.role,
      orgs: publicOrgs(orgs),
    });
  });

  // POST /v1/auth/refresh — public, rotates the refresh family.
  router.post('/v1/auth/refresh', async (ctx, _params, res) => {
    const raw = readRefreshCookie(ctx.req);
    if (!raw) throw unauthenticated('missing refresh token');

    const row = db
      .prepare('SELECT id, user_id, family_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?')
      .get(hashRefreshToken(raw));
    if (!row) throw unauthenticated('invalid refresh token');

    if (row.revoked_at) {
      // Reuse: an already-rotated token came back, so the family is compromised.
      db.prepare(
        `UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`
      ).run(nowIso(), row.family_id);
      throw unauthenticated('refresh token reuse detected');
    }

    if (row.expires_at <= nowIso()) throw unauthenticated('refresh token expired');

    const orgs = membershipsOf(db, row.user_id);
    if (orgs.length === 0) throw forbidden('no active memberships');

    db.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`).run(nowIso(), row.id);

    const nextRaw = newRefreshToken();
    db.prepare(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(newId('rft'), row.user_id, hashRefreshToken(nextRaw), row.family_id, refreshExpiry());
    setRefreshCookie(res, nextRaw);

    const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(row.user_id);
    const active = orgs[0];
    const token = issueAccessToken(
      { userId: row.user_id, orgId: active.id, role: active.role, permVersion: active.perm_version },
      secret
    );

    send(res, 200, {
      token,
      expiresIn: ACCESS_TTL_SECONDS,
      user: { id: user.id, email: user.email, name: user.name },
      orgId: active.id,
      role: active.role,
      orgs: publicOrgs(orgs),
    });
  });

  // GET /v1/auth/me — authenticated, who am I in this org.
  router.get('/v1/auth/me', async (ctx, _params, res) => {
    const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(ctx.userId);
    if (!user) throw notFound();

    const org = db.prepare('SELECT id, name, theme FROM organizations WHERE id = ?').get(ctx.orgId);
    if (!org) throw notFound();

    const orgs = membershipsOf(db, ctx.userId);
    const resolved = resolve(db, { userId: ctx.userId, orgId: ctx.orgId });

    send(res, 200, {
      user: { id: user.id, email: user.email, name: user.name },
      org: { id: org.id, name: org.name, theme: org.theme },
      role: ctx.role,
      orgs: publicOrgs(orgs),
      permissions: resolved.permissions,
    });
  });
}

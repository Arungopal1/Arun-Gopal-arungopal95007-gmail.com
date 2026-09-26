// Invite lifecycle: create / list / revoke (authenticated) + peek / accept (public).
//
// Invites are bearer credentials: only the hash is stored, the raw token is
// returned once at creation, and every state change happens inside a
// transaction so concurrent accepts cannot both win.

import { send, badRequest, notFound, conflict, gone, forbidden } from '../http.js';
import { assertCan } from '../permissions.js';
import { audit, auditDenials } from '../audit.js';
import { assertRoleExists, assertCanModify } from '../lifecycle.js';
import { newId, nowIso } from '../db.js';
import { hashInviteToken, newInviteToken, hashPassword } from '../auth.js';

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normaliseEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Shared public-token lookup for GET /v1/invites/:token and its accept route.
// Order matters: unknown -> 404, dead org -> 404, revoked -> 410,
// already used -> 409, expired -> 410.
function lookupInvite(db, raw) {
  if (!raw || raw.length < 16) throw notFound('invite not found');
  const row = db.prepare(
    `SELECT i.*, o.name AS org_name, o.deleted_at AS org_gone
       FROM invites i JOIN organizations o ON o.id = i.org_id
      WHERE i.token_hash = ?`
  ).get(hashInviteToken(raw));
  if (!row) throw notFound('invite not found');
  if (row.org_gone) throw notFound('invite not found');
  if (row.revoked_at) throw gone('invite was revoked');
  if (row.accepted_at) throw conflict('invite already accepted');
  if (row.expires_at <= nowIso()) throw gone('invite expired');
  return row;
}

export function register(router, { db }) {
  // --- authenticated: create an invite -------------------------------------
  router.post('/v1/orgs/:org/invites', (ctx, params, res) => {
    const email = normaliseEmail(ctx.body.email);
    if (email.length > 320 || !EMAIL_RE.test(email)) {
      throw badRequest('invalid email');
    }

    const role = ctx.body.role;
    if (typeof role !== 'string') throw badRequest('role is required');
    assertRoleExists(db, role);

    auditDenials(db, ctx, { action: 'user.invite', targetType: 'invite', targetId: email }, () => {
      assertCan(db, ctx, 'user:invite');
      if (role === 'owner' && ctx.role !== 'owner') {
        throw forbidden('only an owner may invite an owner');
      }
      assertCanModify(db, ctx.role, role);
    });

    const alreadyMember = db.prepare(
      `SELECT m.id FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ? AND u.email = ? AND m.status != 'removed'`
    ).get(params.org, email);
    if (alreadyMember) throw conflict('that email is already a member of this org');

    const live = db.prepare(
      `SELECT 1 AS x FROM invites
        WHERE org_id = ? AND email = ?
          AND accepted_at IS NULL AND revoked_at IS NULL`
    ).get(params.org, email);
    if (live) throw conflict('a pending invite already exists for that email');

    const raw = newInviteToken();
    const id = newId('inv');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

    db.transaction(() => {
      db.prepare(
        `INSERT INTO invites (id, org_id, email, role, token_hash, invited_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, params.org, email, role, hashInviteToken(raw), ctx.userId, expiresAt);

      // Someone already on the platform gets a placeholder membership so the
      // people list shows the pending invite. A removed row is flipped back
      // to invited (UNIQUE(org_id, user_id) forbids a second row).
      const existingUser = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
      if (existingUser) {
        const existingMem = db.prepare(
          `SELECT id FROM memberships WHERE org_id = ? AND user_id = ?`
        ).get(params.org, existingUser.id);
        if (existingMem) {
          db.prepare(
            `UPDATE memberships
                SET role = ?, status = 'invited', invited_by = ?,
                    perm_version = perm_version + 1
              WHERE id = ?`
          ).run(role, ctx.userId, existingMem.id);
        } else {
          db.prepare(
            `INSERT INTO memberships (id, org_id, user_id, role, status, invited_by)
             VALUES (?, ?, ?, ?, 'invited', ?)`
          ).run(newId('mem'), params.org, existingUser.id, role, ctx.userId);
        }
      }

      audit(db, {
        orgId: ctx.orgId,
        actorId: ctx.userId,
        action: 'user.invite',
        targetType: 'invite',
        targetId: id,
        result: 'allow',
        requestId: ctx.requestId,
      });
    })();

    send(res, 201, { id, email, role, expiresAt, inviteToken: raw });
  });

  // --- authenticated: list pending invites ----------------------------------
  router.get('/v1/orgs/:org/invites', (ctx, params, res) => {
    auditDenials(db, ctx, { action: 'user.invite', targetType: 'invite' }, () => {
      assertCan(db, ctx, 'user:invite');
    });

    const rows = db.prepare(
      `SELECT id, email, role, expires_at, created_at
         FROM invites
        WHERE org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC`
    ).all(params.org);

    send(res, 200, {
      invites: rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      })),
    });
  });

  // --- authenticated: revoke an invite --------------------------------------
  router.delete('/v1/orgs/:org/invites/:id', (ctx, params, res) => {
    auditDenials(db, ctx, { action: 'user.invite', targetType: 'invite', targetId: params.id }, () => {
      assertCan(db, ctx, 'user:invite');
    });

    const invite = db.prepare(
      `SELECT * FROM invites WHERE id = ? AND org_id = ?`
    ).get(params.id, params.org);
    if (!invite) throw notFound('invite not found');
    if (invite.accepted_at) throw conflict('invite already accepted');

    db.transaction(() => {
      db.prepare(`UPDATE invites SET revoked_at = ? WHERE id = ?`).run(nowIso(), invite.id);
      db.prepare(
        `DELETE FROM memberships
          WHERE org_id = ? AND status = 'invited'
            AND user_id IN (SELECT id FROM users WHERE email = ?)`
      ).run(params.org, invite.email);
      audit(db, {
        orgId: ctx.orgId,
        actorId: ctx.userId,
        action: 'user.invite',
        targetType: 'invite',
        targetId: invite.id,
        result: 'allow',
        requestId: ctx.requestId,
      });
    })();

    send(res, 204, undefined);
  });

  // --- public: peek at an invite ---------------------------------------------
  router.get('/v1/invites/:token', (ctx, params, res) => {
    const invite = lookupInvite(db, params.token);
    send(res, 200, {
      email: invite.email,
      role: invite.role,
      orgName: invite.org_name,
      expiresAt: invite.expires_at,
    });
  });

  // --- public: accept an invite ------------------------------------------------
  router.post('/v1/invites/:token/accept', (ctx, params, res) => {
    const invite = lookupInvite(db, params.token);

    const name = String(ctx.body.name ?? '').trim();
    if (name.length < 1 || name.length > 200) {
      throw badRequest('name must be 1-200 characters');
    }
    const password = String(ctx.body.password ?? '');
    if (password.length < 8) {
      throw badRequest('password must be at least 8 characters');
    }

    const at = nowIso();
    let userId = null;

    db.transaction(() => {
      // Single-use claim: exactly one concurrent accept can flip this row.
      const claimed = db.prepare(
        `UPDATE invites SET accepted_at = ?
          WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`
      ).run(at, invite.id);
      if (claimed.changes !== 1) throw conflict('invite already accepted');

      let user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(invite.email);
      if (!user) {
        userId = newId('usr');
        try {
          db.prepare(
            `INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`
          ).run(userId, invite.email, name, hashPassword(password));
        } catch {
          const retry = db.prepare(`SELECT id FROM users WHERE email = ?`).get(invite.email);
          if (!retry) throw conflict('that email is already registered');
          userId = retry.id;
        }
      } else {
        userId = user.id;
      }

      const mem = db.prepare(
        `SELECT id, status FROM memberships WHERE org_id = ? AND user_id = ?`
      ).get(invite.org_id, userId);
      if (!mem) {
        db.prepare(
          `INSERT INTO memberships (id, org_id, user_id, role, status, invited_by, joined_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`
        ).run(newId('mem'), invite.org_id, userId, invite.role, invite.invited_by, at);
      } else if (mem.status === 'active') {
        throw conflict('that email is already a member of this org');
      } else if (mem.status === 'invited' || mem.status === 'removed') {
        db.prepare(
          `UPDATE memberships
              SET status = 'active', role = ?,
                  perm_version = perm_version + 1, joined_at = ?, invited_by = ?
            WHERE id = ?`
        ).run(invite.role, at, invite.invited_by, mem.id);
      } else {
        throw conflict('that email is already a member of this org');
      }

      db.prepare(`UPDATE invites SET accepted_by = ? WHERE id = ?`).run(userId, invite.id);

      audit(db, {
        orgId: invite.org_id,
        actorId: userId,
        action: 'user.invite',
        targetType: 'user',
        targetId: userId,
        result: 'allow',
        requestId: ctx.requestId,
      });
    })();

    send(res, 200, { userId, orgId: invite.org_id, role: invite.role });
  });
}

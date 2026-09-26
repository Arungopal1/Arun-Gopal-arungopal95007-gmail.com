// Org + membership routes: org CRUD, member list, role changes,
// suspend/reinstate, removal (including self-leave), effective
// permissions, and the per-org audit log.

import { send, badRequest, forbidden, notFound, selfRoleChange } from '../http.js';
import { assertCan, resolve } from '../permissions.js';
import { audit, auditDenials } from '../audit.js';
import {
  assertCanModify,
  assertNotLastOwner,
  assertRoleExists,
  endActiveSessions,
} from '../lifecycle.js';
import { bumpPermVersion, newId, nowIso } from '../db.js';

const THEMES = ['cobalt', 'amber', 'moss', 'plum', 'rust', 'teal'];

function validName(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 200;
}

// Pagination for the audit log: limit defaults to 50, offset to 0.
// Boundaries are errors, never clamped (limit 1..200, offset >= 0).
function pagination(query) {
  let limit = 50;
  let offset = 0;
  const rawLimit = query.get('limit');
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw badRequest('limit must be 1..200');
    limit = n;
  }
  const rawOffset = query.get('offset');
  if (rawOffset !== null) {
    const n = Number(rawOffset);
    if (!Number.isInteger(n) || n < 0) throw badRequest('offset must be >= 0');
    offset = n;
  }
  return { limit, offset };
}

function pickTheme(db, requested) {
  if (typeof requested === 'string' && THEMES.includes(requested)) return requested;
  const count = db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n;
  return THEMES[count % THEMES.length];
}

function getMembership(db, orgId, userId) {
  return db
    .prepare('SELECT role, status FROM memberships WHERE org_id = ? AND user_id = ?')
    .get(orgId, userId);
}

// Move a membership to suspended/active. Suspend cascades to sessions,
// reinstate does not. Permission + rank are always enforced.
function setMembershipStatus(db, ctx, targetUserId, nextStatus) {
  const orgId = ctx.orgId;
  const action = nextStatus === 'suspended' ? 'member.suspend' : 'member.reinstate';

  auditDenials(db, ctx, { action, targetType: 'user', targetId: targetUserId }, () => {
    assertCan(db, ctx, 'user:remove');
    const current = getMembership(db, orgId, targetUserId);
    // Rank is checked here so a denial is audited; existence is checked below.
    if (current && current.status !== 'removed') {
      assertCanModify(db, ctx.role, current.role);
    }
  });

  const target = getMembership(db, orgId, targetUserId);
  if (!target || target.status === 'removed') throw notFound('member not found');

  // Re-check rank outside the denial wrapper in case the row changed; cheap and safe.
  assertCanModify(db, ctx.role, target.role);

  if (target.role === 'owner' && nextStatus !== 'active') {
    assertNotLastOwner(db, orgId, targetUserId);
  }

  db.transaction(() => {
    db.prepare('UPDATE memberships SET status = ? WHERE org_id = ? AND user_id = ?').run(
      nextStatus,
      orgId,
      targetUserId
    );
    bumpPermVersion(db, { orgId, userId: targetUserId });
    if (nextStatus === 'suspended') {
      endActiveSessions(db, { orgId, userId: targetUserId, reason: 'user_suspended' });
    }
    audit(db, {
      orgId,
      actorId: ctx.userId,
      action,
      targetType: 'user',
      targetId: targetUserId,
      result: 'allow',
      requestId: ctx.requestId,
    });
  })();
}

// Drop a membership to removed. Self-leave skips the permission/rank gate
// but still honours the last-owner invariant.
function removeMembership(db, ctx, targetUserId) {
  const orgId = ctx.orgId;
  const isSelf = targetUserId === ctx.userId;
  const action = isSelf ? 'member.leave' : 'member.remove';

  const target = getMembership(db, orgId, targetUserId);
  if (!target || target.status === 'removed') throw notFound('member not found');

  if (!isSelf) {
    auditDenials(db, ctx, { action, targetType: 'user', targetId: targetUserId }, () => {
      assertCan(db, ctx, 'user:remove');
      assertCanModify(db, ctx.role, target.role);
    });
    // Re-assert after the denial boundary so the checks definitely ran.
    assertCanModify(db, ctx.role, target.role);
  }

  assertNotLastOwner(db, orgId, targetUserId);

  db.transaction(() => {
    db.prepare('UPDATE memberships SET status = ? WHERE org_id = ? AND user_id = ?').run(
      'removed',
      orgId,
      targetUserId
    );
    bumpPermVersion(db, { orgId, userId: targetUserId });
    endActiveSessions(db, { orgId, userId: targetUserId, reason: 'membership_removed' });
    audit(db, {
      orgId,
      actorId: ctx.userId,
      action,
      targetType: 'user',
      targetId: targetUserId,
      result: 'allow',
      requestId: ctx.requestId,
    });
  })();
}

export function register(router, { db }) {
  // GET /v1/orgs — every org where the caller holds an active membership.
  router.get('/v1/orgs', (ctx, _params, res) => {
    const rows = db
      .prepare(
        `SELECT o.id AS id, o.name AS name, o.theme AS theme, m.role AS role, m.status AS status
           FROM memberships m
           JOIN organizations o ON o.id = m.org_id
          WHERE m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL
          ORDER BY o.name ASC`
      )
      .all(ctx.userId);
    send(res, 200, { orgs: rows });
  });

  // POST /v1/orgs — create an org; the creator becomes its sole owner.
  router.post('/v1/orgs', (ctx, _params, res) => {
    const body = ctx.body ?? {};
    if (!validName(body.name)) throw badRequest('name must be 1-200 characters');
    const name = body.name.trim();
    const theme = pickTheme(db, body.theme);

    const orgId = newId('org');
    const memId = newId('mem');
    const at = nowIso();

    db.transaction(() => {
      db.prepare('INSERT INTO organizations (id, name, theme) VALUES (?, ?, ?)').run(
        orgId,
        name,
        theme
      );
      db.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, status, joined_at)
         VALUES (?, ?, ?, 'owner', 'active', ?)`
      ).run(memId, orgId, ctx.userId, at);
      audit(db, {
        orgId,
        actorId: ctx.userId,
        action: 'org.create',
        targetType: 'org',
        targetId: orgId,
        result: 'allow',
        requestId: ctx.requestId,
      });
    })();

    send(res, 201, { id: orgId, name, theme, role: 'owner' });
  });

  // PATCH /v1/orgs/:org — rename.
  router.patch('/v1/orgs/:org', (ctx, _params, res) => {
    const orgId = ctx.orgId;
    auditDenials(
      db,
      ctx,
      { action: 'org.update', targetType: 'org', targetId: orgId },
      () => assertCan(db, ctx, 'org:update')
    );

    const body = ctx.body ?? {};
    if (!validName(body.name)) throw badRequest('name must be 1-200 characters');
    const name = body.name.trim();

    db.transaction(() => {
      db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(name, orgId);
      audit(db, {
        orgId,
        actorId: ctx.userId,
        action: 'org.update',
        targetType: 'org',
        targetId: orgId,
        result: 'allow',
        requestId: ctx.requestId,
      });
    })();

    send(res, 200, { id: orgId, name });
  });

  // DELETE /v1/orgs/:org — soft delete.
  router.delete('/v1/orgs/:org', (ctx, _params, res) => {
    const orgId = ctx.orgId;
    auditDenials(
      db,
      ctx,
      { action: 'org.delete', targetType: 'org', targetId: orgId },
      () => assertCan(db, ctx, 'org:delete')
    );

    db.transaction(() => {
      db.prepare('UPDATE organizations SET deleted_at = ? WHERE id = ?').run(nowIso(), orgId);
      audit(db, {
        orgId,
        actorId: ctx.userId,
        action: 'org.delete',
        targetType: 'org',
        targetId: orgId,
        result: 'allow',
        requestId: ctx.requestId,
      });
    })();

    send(res, 204, undefined);
  });

  // GET /v1/orgs/:org/members — everyone not removed, ordered by name.
  router.get('/v1/orgs/:org/members', (ctx, _params, res) => {
    assertCan(db, ctx, 'user:read');
    const rows = db
      .prepare(
        `SELECT m.user_id AS id, m.user_id AS userId, u.name AS name, u.email AS email,
                m.role AS role, m.status AS status
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.org_id = ? AND m.status != 'removed'
          ORDER BY u.name ASC`
      )
      .all(ctx.orgId);
    send(res, 200, { members: rows });
  });

  // DELETE /v1/orgs/:org/members/me — leave. Registered before :userId.
  router.delete('/v1/orgs/:org/members/me', (ctx, _params, res) => {
    assertNotLastOwner(db, ctx.orgId, ctx.userId);
    removeMembership(db, ctx, ctx.userId);
    send(res, 204, undefined);
  });

  // PATCH /v1/orgs/:org/members/:userId — change a role, grandfather sessions.
  router.patch('/v1/orgs/:org/members/:userId', (ctx, params, res) => {
    const targetUserId = params.userId;
    if (targetUserId === ctx.userId) throw selfRoleChange();

    const nextRole = ctx.body?.role;
    if (typeof nextRole !== 'string') throw badRequest('role is required');
    assertRoleExists(db, nextRole);

    auditDenials(
      db,
      ctx,
      { action: 'user.role.update', targetType: 'user', targetId: targetUserId },
      () => {
        assertCan(db, ctx, 'user:role:update');
        const current = getMembership(db, ctx.orgId, targetUserId);
        if (current && current.status !== 'removed') {
          assertCanModify(db, ctx.role, current.role);
        }
        if (nextRole === 'owner' && ctx.role !== 'owner') {
          throw forbidden('only an owner can confer owner');
        }
      }
    );

    const target = getMembership(db, ctx.orgId, targetUserId);
    if (!target || target.status === 'removed') throw notFound('member not found');
    assertCanModify(db, ctx.role, target.role);
    if (nextRole === 'owner' && ctx.role !== 'owner') {
      throw forbidden('only an owner can confer owner');
    }
    if (target.role === 'owner' && nextRole !== 'owner') {
      assertNotLastOwner(db, ctx.orgId, targetUserId);
    }

    db.transaction(() => {
      db.prepare('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?').run(
        nextRole,
        ctx.orgId,
        targetUserId
      );
      bumpPermVersion(db, { orgId: ctx.orgId, userId: targetUserId });
      audit(db, {
        orgId: ctx.orgId,
        actorId: ctx.userId,
        action: 'user.role.update',
        targetType: 'user',
        targetId: targetUserId,
        result: 'allow',
        requestId: ctx.requestId,
      });
    })();

    send(res, 200, { id: targetUserId, role: nextRole });
  });

  // POST /v1/orgs/:org/members/:userId/suspend
  router.post('/v1/orgs/:org/members/:userId/suspend', (ctx, params, res) => {
    setMembershipStatus(db, ctx, params.userId, 'suspended');
    send(res, 200, { id: params.userId, status: 'suspended' });
  });

  // DELETE /v1/orgs/:org/members/:userId/suspend — reinstate, no cascade.
  router.delete('/v1/orgs/:org/members/:userId/suspend', (ctx, params, res) => {
    setMembershipStatus(db, ctx, params.userId, 'active');
    send(res, 200, { id: params.userId, status: 'active' });
  });

  // DELETE /v1/orgs/:org/members/:userId — remove (or self-leave via helper).
  router.delete('/v1/orgs/:org/members/:userId', (ctx, params, res) => {
    removeMembership(db, ctx, params.userId);
    send(res, 204, undefined);
  });

  // GET /v1/orgs/:org/users/:userId/effective — resolved permissions for one user.
  router.get('/v1/orgs/:org/users/:userId/effective', (ctx, params, res) => {
    const targetUserId = params.userId;
    if (targetUserId !== ctx.userId) {
      assertCan(db, ctx, 'user:read');
    }
    const mem = getMembership(db, ctx.orgId, targetUserId);
    if (!mem || mem.status === 'removed') throw notFound('member not found');

    const deviceId = ctx.query.get('deviceId') ?? null;
    const out = resolve(db, { userId: targetUserId, orgId: ctx.orgId, deviceId });
    send(res, 200, {
      userId: targetUserId,
      orgId: ctx.orgId,
      deviceId,
      role: out.role,
      permissions: out.permissions,
    });
  });

  // GET /v1/orgs/:org/audit — append-only log, newest first.
  router.get('/v1/orgs/:org/audit', (ctx, _params, res) => {
    assertCan(db, ctx, 'audit:read');
    const { limit, offset } = pagination(ctx.query);
    const since = ctx.query.get('since');

    let rows;
    if (since !== null && since !== '') {
      rows = db
        .prepare(
          `SELECT id, org_id, actor_id, action, target_type, target_id,
                  result, reason_code, request_id, at
             FROM audit_events
            WHERE org_id = ? AND at >= ?
            ORDER BY at DESC
            LIMIT ? OFFSET ?`
        )
        .all(ctx.orgId, since, limit, offset);
    } else {
      rows = db
        .prepare(
          `SELECT id, org_id, actor_id, action, target_type, target_id,
                  result, reason_code, request_id, at
             FROM audit_events
            WHERE org_id = ?
            ORDER BY at DESC
            LIMIT ? OFFSET ?`
        )
        .all(ctx.orgId, limit, offset);
    }
    send(res, 200, { events: rows, limit, offset });
  });
}

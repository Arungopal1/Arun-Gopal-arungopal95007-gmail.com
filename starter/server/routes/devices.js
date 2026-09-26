import { send, badRequest, notFound, forbidden, normalizeTs } from '../http.js';
import { assertCan, assertMayGrant, resolve, resolveDevices } from '../permissions.js';
import { audit, auditDenials } from '../audit.js';
import { endActiveSessions } from '../lifecycle.js';
import { newId, nowIso, bumpPermVersion } from '../db.js';

const KINDS = new Set(['macos', 'windows', 'linux', 'android', 'ios']);

function requireDevice(db, orgId, deviceId) {
  const row = db
    .prepare(
      'SELECT id, name, kind, online FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
    )
    .get(deviceId, orgId);
  if (!row) throw notFound();
  return row;
}

function toOnline(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 0 || value === 1) return value;
  if (typeof value === 'number') return value ? 1 : 0;
  throw badRequest('online must be a boolean');
}

export function register(router, { db }) {
  // -------------------------------------------------------------------------
  // GET /v1/orgs/:org/devices — device:list gates endpoint, device:view gates rows
  // -------------------------------------------------------------------------
  router.get('/v1/orgs/:org/devices', (ctx, _params, res) => {
    assertCan(db, ctx, 'device:list');
    const rows = db
      .prepare(
        'SELECT id, name, kind, online FROM devices WHERE org_id = ? AND deleted_at IS NULL ORDER BY name'
      )
      .all(ctx.orgId);
    if (rows.length === 0) {
      send(res, 200, { devices: [] });
      return;
    }
    const ids = rows.map((r) => r.id);
    const { byDevice } = resolveDevices(db, {
      userId: ctx.userId,
      orgId: ctx.orgId,
      deviceIds: ids,
    });
    const devices = [];
    for (const r of rows) {
      const perms = byDevice[r.id];
      if (perms?.['device:view']?.effect !== 'allow') continue;
      devices.push({
        id: r.id,
        name: r.name,
        kind: r.kind,
        online: Boolean(r.online),
        permissions: perms,
      });
    }
    send(res, 200, { devices });
  });

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:org/devices/:id — invisible (404) when not viewable
  // -------------------------------------------------------------------------
  router.get('/v1/orgs/:org/devices/:id', (ctx, params, res) => {
    const row = requireDevice(db, ctx.orgId, params.id);
    const out = resolve(db, {
      userId: ctx.userId,
      orgId: ctx.orgId,
      deviceId: row.id,
    });
    if (out.permissions['device:view']?.effect !== 'allow') throw notFound();
    send(res, 200, {
      id: row.id,
      name: row.name,
      kind: row.kind,
      online: Boolean(row.online),
      permissions: out.permissions,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/orgs/:org/devices
  // -------------------------------------------------------------------------
  router.post('/v1/orgs/:org/devices', (ctx, _params, res) => {
    auditDenials(
      db,
      ctx,
      { action: 'device.create', targetType: 'device', targetId: null },
      () => {
        assertCan(db, ctx, 'device:provision');
        const { name, kind } = ctx.body ?? {};
        if (typeof name !== 'string' || name.length < 1 || name.length > 200) {
          throw badRequest('name must be 1-200 characters');
        }
        if (!KINDS.has(kind)) {
          throw badRequest('kind must be one of macos/windows/linux/android/ios');
        }
        let onlineInt = 0;
        if (ctx.body.online !== undefined && ctx.body.online !== null) {
          onlineInt = toOnline(ctx.body.online);
        }
        const id = newId('dev');
        const txn = db.transaction(() => {
          db.prepare(
            'INSERT INTO devices (id, org_id, name, kind, online) VALUES (?, ?, ?, ?, ?)'
          ).run(id, ctx.orgId, name, kind, onlineInt);
          audit(db, {
            orgId: ctx.orgId,
            actorId: ctx.userId,
            action: 'device.create',
            targetType: 'device',
            targetId: id,
            result: 'allow',
            requestId: ctx.requestId,
          });
        });
        txn();
        send(res, 201, { id, name, kind });
      }
    );
  });

  // -------------------------------------------------------------------------
  // PATCH /v1/orgs/:org/devices/:id
  // -------------------------------------------------------------------------
  router.patch('/v1/orgs/:org/devices/:id', (ctx, params, res) => {
    const existing = requireDevice(db, ctx.orgId, params.id);
    auditDenials(
      db,
      ctx,
      { action: 'device.update', targetType: 'device', targetId: existing.id },
      () => {
        assertCan(db, ctx, 'device:update', existing.id);
        const { name, online } = ctx.body ?? {};
        let nextName = existing.name;
        let nextOnline = existing.online;
        let touched = false;
        if (name !== undefined) {
          if (typeof name !== 'string' || name.length < 1 || name.length > 200) {
            throw badRequest('name must be 1-200 characters');
          }
          nextName = name;
          touched = true;
        }
        if (online !== undefined) {
          nextOnline = toOnline(online);
          touched = true;
        }
        if (touched) {
          const txn = db.transaction(() => {
            db.prepare('UPDATE devices SET name = ?, online = ? WHERE id = ?').run(
              nextName,
              nextOnline,
              existing.id
            );
            audit(db, {
              orgId: ctx.orgId,
              actorId: ctx.userId,
              action: 'device.update',
              targetType: 'device',
              targetId: existing.id,
              result: 'allow',
              requestId: ctx.requestId,
            });
          });
          txn();
        } else {
          audit(db, {
            orgId: ctx.orgId,
            actorId: ctx.userId,
            action: 'device.update',
            targetType: 'device',
            targetId: existing.id,
            result: 'allow',
            requestId: ctx.requestId,
          });
        }
        send(res, 200, {
          id: existing.id,
          name: nextName,
          online: Boolean(nextOnline),
        });
      }
    );
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/orgs/:org/devices/:id — soft delete + end sessions
  // -------------------------------------------------------------------------
  router.delete('/v1/orgs/:org/devices/:id', (ctx, params, res) => {
    const existing = requireDevice(db, ctx.orgId, params.id);
    auditDenials(
      db,
      ctx,
      { action: 'device.delete', targetType: 'device', targetId: existing.id },
      () => {
        assertCan(db, ctx, 'device:provision', existing.id);
        const txn = db.transaction(() => {
          db.prepare('UPDATE devices SET deleted_at = ? WHERE id = ?').run(
            nowIso(),
            existing.id
          );
          endActiveSessions(db, {
            orgId: ctx.orgId,
            deviceId: existing.id,
            reason: 'device_transferred',
          });
          audit(db, {
            orgId: ctx.orgId,
            actorId: ctx.userId,
            action: 'device.delete',
            targetType: 'device',
            targetId: existing.id,
            result: 'allow',
            requestId: ctx.requestId,
          });
        });
        txn();
        send(res, 204, undefined);
      }
    );
  });

  // -------------------------------------------------------------------------
  // POST /v1/orgs/:org/devices/:id/transfer
  // -------------------------------------------------------------------------
  router.post('/v1/orgs/:org/devices/:id/transfer', (ctx, params, res) => {
    const existing = requireDevice(db, ctx.orgId, params.id);
    const rawTarget = ctx.body?.targetOrgId ?? ctx.body?.target_org_id;
    if (typeof rawTarget !== 'string' || rawTarget.length === 0) {
      throw badRequest('targetOrgId is required');
    }
    const targetOrgId = rawTarget;
    auditDenials(
      db,
      ctx,
      { action: 'device.transfer', targetType: 'device', targetId: existing.id },
      () => {
        assertCan(db, ctx, 'device:provision', existing.id);
        const target = db
          .prepare('SELECT id FROM organizations WHERE id = ? AND deleted_at IS NULL')
          .get(targetOrgId);
        if (!target) throw notFound();
        const out = resolve(db, { userId: ctx.userId, orgId: targetOrgId });
        if (out.permissions['device:provision']?.effect !== 'allow') {
          throw forbidden('missing permission: device:provision in target org');
        }
        const txn = db.transaction(() => {
          db.prepare('UPDATE devices SET org_id = ? WHERE id = ?').run(
            targetOrgId,
            existing.id
          );
          db.prepare(
            'DELETE FROM grant_permissions WHERE grant_id IN (SELECT id FROM grants WHERE device_id = ?)'
          ).run(existing.id);
          db.prepare('DELETE FROM grants WHERE device_id = ?').run(existing.id);
          endActiveSessions(db, {
            orgId: ctx.orgId,
            deviceId: existing.id,
            reason: 'device_transferred',
          });
          audit(db, {
            orgId: ctx.orgId,
            actorId: ctx.userId,
            action: 'device.transfer',
            targetType: 'device',
            targetId: existing.id,
            result: 'allow',
            requestId: ctx.requestId,
          });
        });
        txn();
        send(res, 200, { id: existing.id, orgId: targetOrgId });
      }
    );
  });

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:org/grants
  // -------------------------------------------------------------------------
  router.get('/v1/orgs/:org/grants', (ctx, _params, res) => {
    assertCan(db, ctx, 'user:read');
    const filterUserId =
      typeof ctx.query?.get === 'function'
        ? (ctx.query?.get('userId') ?? null)
        : ((ctx.query?.userId ?? ctx.query?.user_id ?? null) || null);
    let rows;
    if (filterUserId) {
      rows = db
        .prepare(
          `SELECT g.id AS id, g.user_id AS userId, g.device_id AS deviceId,
                  g.effect AS effect, g.starts_at AS startsAt, g.expires_at AS expiresAt,
                  g.created_by AS createdBy, group_concat(gp.permission) AS permCsv
             FROM grants g LEFT JOIN grant_permissions gp ON gp.grant_id = g.id
            WHERE g.org_id = ? AND g.revoked_at IS NULL AND g.user_id = ?
            GROUP BY g.id ORDER BY g.created_at, g.id`
        )
        .all(ctx.orgId, filterUserId);
    } else {
      rows = db
        .prepare(
          `SELECT g.id AS id, g.user_id AS userId, g.device_id AS deviceId,
                  g.effect AS effect, g.starts_at AS startsAt, g.expires_at AS expiresAt,
                  g.created_by AS createdBy, group_concat(gp.permission) AS permCsv
             FROM grants g LEFT JOIN grant_permissions gp ON gp.grant_id = g.id
            WHERE g.org_id = ? AND g.revoked_at IS NULL
            GROUP BY g.id ORDER BY g.created_at, g.id`
        )
        .all(ctx.orgId);
    }
    const grants = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      deviceId: r.deviceId,
      effect: r.effect,
      permissions: r.permCsv ? r.permCsv.split(',') : [],
      startsAt: r.startsAt,
      expiresAt: r.expiresAt,
      createdBy: r.createdBy,
    }));
    send(res, 200, { grants });
  });

  // -------------------------------------------------------------------------
  // POST /v1/orgs/:org/grants
  // -------------------------------------------------------------------------
  router.post('/v1/orgs/:org/grants', (ctx, _params, res) => {
    auditDenials(
      db,
      ctx,
      { action: 'grant.create', targetType: 'grant', targetId: null },
      () => {
        assertCan(db, ctx, 'grant:create');
        const body = ctx.body ?? {};
        const userId = body.userId ?? body.user_id;
        let deviceId = body.deviceId ?? body.device_id;
        if (deviceId === undefined) deviceId = null;
        const effect = body.effect;
        const permissions = body.permissions;
        const startsRaw = body.startsAt ?? body.starts_at ?? null;
        const expiresRaw = body.expiresAt ?? body.expires_at ?? null;

        if (typeof userId !== 'string' || userId.length === 0) {
          throw badRequest('userId must be a string');
        }
        if (userId === ctx.userId) {
          throw forbidden('you cannot grant to yourself', 'self_grant');
        }
        if (deviceId !== null) {
          if (typeof deviceId !== 'string' || deviceId.length === 0) {
            throw badRequest('deviceId must be a string or null');
          }
        }
        if (
          !Array.isArray(permissions) ||
          permissions.length === 0 ||
          !permissions.every((p) => typeof p === 'string' && p.length > 0)
        ) {
          throw badRequest('permissions must be a non-empty array of strings');
        }
        if (effect !== 'allow' && effect !== 'deny') {
          throw badRequest('effect must be allow or deny');
        }
        const wanted = [...new Set(permissions)];

        const mem = db
          .prepare('SELECT status FROM memberships WHERE org_id = ? AND user_id = ?')
          .get(ctx.orgId, userId);
        if (!mem || mem.status !== 'active') throw notFound();

        if (deviceId !== null) {
          const dev = db
            .prepare(
              'SELECT id FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
            )
            .get(deviceId, ctx.orgId);
          if (!dev) throw notFound();
        }

        const startsAt = normalizeTs(startsRaw, 'startsAt');
        const expiresAt = normalizeTs(expiresRaw, 'expiresAt');
        if (expiresAt !== null) {
          if (expiresAt <= nowIso()) {
            throw badRequest('grant is already expired', 'expired_grant');
          }
          if (startsAt !== null && expiresAt <= startsAt) {
            throw badRequest('expiresAt must be after startsAt');
          }
        }

        assertMayGrant(db, ctx, wanted, deviceId);

        const id = newId('grt');
        const txn = db.transaction(() => {
          db.prepare(
            `INSERT INTO grants (id, org_id, user_id, device_id, effect, starts_at, expires_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(id, ctx.orgId, userId, deviceId, effect, startsAt, expiresAt, ctx.userId);
          const ins = db.prepare(
            'INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)'
          );
          for (const p of wanted) ins.run(id, p);
          bumpPermVersion(db, { orgId: ctx.orgId, userId });
          audit(db, {
            orgId: ctx.orgId,
            actorId: ctx.userId,
            action: 'grant.create',
            targetType: 'grant',
            targetId: id,
            result: 'allow',
            requestId: ctx.requestId,
          });
        });
        try {
          txn();
        } catch (err) {
          if (
            err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
            String(err?.message ?? '').includes('FOREIGN KEY')
          ) {
            throw badRequest('unknown permission', 'unknown_permission');
          }
          throw err;
        }
        send(res, 201, { id, userId, deviceId, effect, permissions: wanted });
      }
    );
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/orgs/:org/grants/:id
  // -------------------------------------------------------------------------
  router.delete('/v1/orgs/:org/grants/:id', (ctx, params, res) => {
    auditDenials(
      db,
      ctx,
      { action: 'grant.revoke', targetType: 'grant', targetId: params.id },
      () => {
        assertCan(db, ctx, 'grant:revoke');
        const row = db
          .prepare(
            'SELECT id, user_id AS userId FROM grants WHERE id = ? AND org_id = ? AND revoked_at IS NULL'
          )
          .get(params.id, ctx.orgId);
        if (!row) throw notFound();
        const txn = db.transaction(() => {
          db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').run(
            nowIso(),
            row.id
          );
          bumpPermVersion(db, { orgId: ctx.orgId, userId: row.userId });
          audit(db, {
            orgId: ctx.orgId,
            actorId: ctx.userId,
            action: 'grant.revoke',
            targetType: 'grant',
            targetId: row.id,
            result: 'allow',
            requestId: ctx.requestId,
          });
        });
        txn();
        send(res, 204, undefined);
      }
    );
  });
}

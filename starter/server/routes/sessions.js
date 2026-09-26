import { badRequest, notFound, conflict, deviceBusy, send } from '../http.js';
import { newId, nowIso } from '../db.js';
import { assertCan, assertCanStartSession } from '../permissions.js';
import { audit, auditDenials } from '../audit.js';
import { snapshotAuthority, sessionExpiry } from '../lifecycle.js';

function sweepExpired(db, orgId) {
  const now = nowIso();
  db.prepare(
    `UPDATE sessions SET state = 'ended', ended_at = ?, end_reason = 'session_expired'
     WHERE org_id = ? AND state = 'active' AND expires_at <= ?`
  ).run(now, orgId, now);
}

export function register(router, { db }) {
  router.post('/v1/orgs/:org/sessions', async (ctx, params, res) => {
    const mode = ctx.body?.mode;
    if (mode !== 'view' && mode !== 'control' && mode !== 'terminal') {
      throw badRequest('mode must be one of view, control, terminal');
    }
    const deviceId = ctx.body?.deviceId ?? ctx.body?.device_id;
    if (!deviceId) throw badRequest('deviceId is required');

    const device = db
      .prepare(
        `SELECT id FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
      )
      .get(deviceId, ctx.orgId);
    if (!device) throw notFound('device not found');

    auditDenials(
      db,
      ctx,
      { action: 'session.start', targetType: 'device', targetId: deviceId },
      () => assertCanStartSession(db, ctx, mode, deviceId)
    );

    sweepExpired(db, ctx.orgId);

    const id = newId('ses');
    const authority = snapshotAuthority(db, {
      userId: ctx.userId,
      orgId: ctx.orgId,
      deviceId,
    });
    const expiresAt = sessionExpiry(db, ctx.orgId);
    const startedAt = nowIso();

    try {
      db.prepare(
        `INSERT INTO sessions (id, org_id, user_id, device_id, mode, state, authorized_by, started_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      ).run(id, ctx.orgId, ctx.userId, deviceId, mode, authority, startedAt, expiresAt);
    } catch (err) {
      if (err?.code?.startsWith?.('SQLITE_CONSTRAINT')) {
        const holder = db
          .prepare(
            `SELECT id FROM sessions
             WHERE device_id = ? AND state = 'active' AND mode IN ('control', 'terminal')
             ORDER BY started_at DESC LIMIT 1`
          )
          .get(deviceId);
        if (holder) throw deviceBusy(`device already has an exclusive session (${holder.id})`);
      }
      throw err;
    }

    audit(db, {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'session.start',
      targetType: 'device',
      targetId: deviceId,
      result: 'allow',
      reasonCode: null,
      requestId: ctx.requestId,
    });

    send(res, 201, { id, deviceId, mode, state: 'active' });
  });

  router.get('/v1/orgs/:org/sessions', async (ctx, params, res) => {
    assertCan(db, ctx, 'session:view');

    sweepExpired(db, ctx.orgId);

    const rows = db
      .prepare(
        `SELECT s.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN devices d ON d.id = s.device_id
         WHERE s.org_id = ?
         ORDER BY s.started_at DESC, s.id DESC
         LIMIT 200`
      )
      .all(ctx.orgId);

    send(res, 200, { sessions: rows });
  });

  router.get('/v1/sessions/:id', async (ctx, params, res) => {
    sweepExpired(db, ctx.orgId);

    const row = db
      .prepare(`SELECT * FROM sessions WHERE id = ? AND org_id = ?`)
      .get(params.id, ctx.orgId);
    if (!row) throw notFound('session not found');

    if (row.user_id !== ctx.userId) {
      assertCan(db, ctx, 'session:view');
    }

    send(res, 200, row);
  });

  router.delete('/v1/sessions/:id', async (ctx, params, res) => {
    sweepExpired(db, ctx.orgId);

    const row = db
      .prepare(`SELECT * FROM sessions WHERE id = ? AND org_id = ?`)
      .get(params.id, ctx.orgId);
    if (!row) throw notFound('session not found');

    const isOwn = row.user_id === ctx.userId;
    if (!isOwn) {
      auditDenials(
        db,
        ctx,
        { action: 'session.terminate', targetType: 'session', targetId: row.id },
        () => assertCan(db, ctx, 'session:terminate')
      );
    }

    if (row.state === 'ended') throw conflict('session already ended');

    const reason = isOwn ? 'user_stopped' : 'admin_terminated';
    db.prepare(
      `UPDATE sessions SET state = 'ended', ended_at = ?, end_reason = ? WHERE id = ?`
    ).run(nowIso(), reason, row.id);

    audit(db, {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: isOwn ? 'session.stop' : 'session.terminate',
      targetType: 'session',
      targetId: row.id,
      result: 'allow',
      reasonCode: null,
      requestId: ctx.requestId,
    });

    send(res, 204);
  });
}

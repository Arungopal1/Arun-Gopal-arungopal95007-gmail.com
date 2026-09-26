// Append-only audit writes. Only INSERTs — the table triggers reject updates/deletes.

import { newId, nowIso } from './db.js';

export function audit(db, { orgId, actorId = null, action, targetType = null, targetId = null, result, reasonCode = null, requestId = null }) {
  db.prepare(
    `INSERT INTO audit_events (id, org_id, actor_id, action, target_type, target_id, result, reason_code, request_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId('aud'), orgId, actorId, action, targetType, targetId, result, reasonCode, requestId, nowIso());
}

// Run fn(); on a permission refusal, record the denial then rethrow.
// Denials only — success rows are written by routes inside their own transactions.
export function auditDenials(db, ctx, meta, fn) {
  try {
    return fn();
  } catch (err) {
    if (err?.code === 'FORBIDDEN') {
      audit(db, {
        orgId: ctx.orgId,
        actorId: ctx.userId,
        result: 'deny',
        reasonCode: err.reason ?? 'missing_permission',
        requestId: ctx.requestId,
        ...meta,
      });
    }
    throw err;
  }
}

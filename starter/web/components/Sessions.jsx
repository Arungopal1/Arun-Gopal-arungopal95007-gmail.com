// Remote sessions. Stopping your own session is gated on the start entry;
// ending anyone else's needs the terminate entry. (The server snapshots
// authority at start, so a live row and its device buttons may disagree —
// that is expected, not reconciled here.)
import React, { useEffect, useState } from 'react';
import { api, isAllowed, describeError, fmtTime } from '../api.js';

export default function Sessions({ orgId, session }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/orgs/${orgId}/sessions`);
      setRows(data.sessions || []);
    } catch (err) {
      setError(err);
      setRows([]);
    }
  }

  useEffect(() => {
    load();
  }, [orgId]);

  async function start() {
    const deviceId = window.prompt('Device ID for the new session:');
    if (deviceId === null || deviceId.trim() === '') return;
    const mode = window.prompt('Mode (view, control, terminal):', 'view');
    if (mode === null) return;
    setBusy('new');
    try {
      await api.post(`/orgs/${orgId}/sessions`, { deviceId: deviceId.trim(), mode: mode.trim() });
      await load();
    } catch (err) {
      window.alert(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function stop(id) {
    setBusy(`stop:${id}`);
    try {
      await api.del(`/sessions/${id}`);
      await load();
    } catch (err) {
      window.alert(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  if (rows === null && !error) {
    return (
      <section>
        <h2>Sessions</h2>
        <p>Loading sessions…</p>
      </section>
    );
  }

  const canStart = isAllowed(session.permissions, 'session:start');
  const canTerminate = isAllowed(session.permissions, 'session:terminate');

  function stopEntry(row) {
    const owner = row.user_id || row.userId;
    if (owner === session.user.id) {
      return canStart ? { permission: 'session:start' } : null;
    }
    return canTerminate ? { permission: 'session:terminate' } : null;
  }

  return (
    <section>
      <h2>Sessions</h2>
      {canStart ? (
        <button
          type="button"
          data-testid="new-session"
          data-permission="session:start"
          data-state="unlocked"
          onClick={busy ? undefined : start}
        >
          New session
        </button>
      ) : null}
      {error ? (
        <div role="alert" data-testid="sessions-error">
          {describeError(error)}
        </div>
      ) : null}
      <table data-testid="sessions-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Device</th>
            <th>User</th>
            <th>Mode</th>
            <th>State</th>
            <th>Started</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const entry = stopEntry(s);
            const active = s.state === 'active';
            return (
              <tr
                key={s.id}
                data-testid="session-row"
                data-session-id={s.id}
                data-state={s.state}
                data-mode={s.mode}
              >
                <td>{s.id}</td>
                <td>{s.device_id || s.deviceId}</td>
                <td>{s.user_id || s.userId}</td>
                <td>{s.mode}</td>
                <td>{s.state}</td>
                <td>{fmtTime(s.started_at || s.startedAt)}</td>
                <td>
                  {active && entry ? (
                    <button
                      type="button"
                      data-testid="stop-session"
                      data-permission={entry.permission}
                      data-state="unlocked"
                      onClick={busy ? undefined : () => stop(s.id)}
                    >
                      Stop
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// Append-only audit log, newest first. The allow/deny filters are plain
// client-side view controls — reaching this view at all is what the
// audit:read entry gates.
import React, { useEffect, useState } from 'react';
import { api, describeError, fmtTime } from '../api.js';

export default function Audit({ orgId }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get(`/orgs/${orgId}/audit?limit=100`);
        if (!cancelled) setEvents(data.events || []);
      } catch (err) {
        if (!cancelled) {
          setError(err);
          setEvents([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  if (events === null && !error) {
    return (
      <section>
        <h2>Audit</h2>
        <p>Loading audit log…</p>
      </section>
    );
  }

  const visible = events.filter((e) => filter === 'all' || e.result === filter);

  return (
    <section>
      <h2>Audit</h2>
      <div>
        <button type="button" data-testid="audit-filter-all" onClick={() => setFilter('all')}>
          All
        </button>{' '}
        <button type="button" data-testid="audit-filter-allow" onClick={() => setFilter('allow')}>
          Allow
        </button>{' '}
        <button type="button" data-testid="audit-filter-deny" onClick={() => setFilter('deny')}>
          Deny
        </button>
      </div>
      {error ? (
        <div role="alert" data-testid="audit-error">
          {describeError(error)}
        </div>
      ) : null}
      <table data-testid="audit-table">
        <thead>
          <tr>
            <th>Action</th>
            <th>Result</th>
            <th>Actor</th>
            <th>Target</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((e) => (
            <tr key={e.id} data-testid="audit-row" data-result={e.result} data-action={e.action}>
              <td>{e.action}</td>
              <td>{e.result}</td>
              <td>{e.actor_id || e.actorId}</td>
              <td>
                {e.target_type || e.targetType}:{e.target_id || e.targetId}
              </td>
              <td>{fmtTime(e.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

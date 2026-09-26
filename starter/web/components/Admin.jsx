// Org administration. Rename needs org:update; deleting the org needs
// org:delete. After a delete the token's org is gone, so the console signs
// out and boots fresh.
import React, { useState } from 'react';
import { api, isAllowed, describeError } from '../api.js';

export default function Admin({ orgId, session, onOrgChanged }) {
  const [busy, setBusy] = useState(null);

  const canRename = isAllowed(session.permissions, 'org:update');
  const canDelete = isAllowed(session.permissions, 'org:delete');

  async function rename() {
    const name = window.prompt('Organization name:', session.org.name);
    if (name === null || name.trim() === '') return;
    setBusy('rename');
    try {
      await api.patch(`/orgs/${orgId}`, { name: name.trim() });
      await onOrgChanged();
    } catch (err) {
      window.alert(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${session.org.name}? This cannot be undone.`)) return;
    setBusy('delete');
    try {
      await api.del(`/orgs/${orgId}`);
      api.logout();
      window.location.reload();
    } catch (err) {
      window.alert(describeError(err));
      setBusy(null);
    }
  }

  return (
    <section>
      <h2>Admin</h2>
      <div data-testid="admin-card">
        <h3>{session.org.name}</h3>
        <p>Org ID: {session.org.id}</p>
        <p>
          Your role: <span data-testid="active-role-inline">{session.role}</span>
        </p>
        <p>
          {canRename ? (
            <button
              type="button"
              data-testid="rename-org"
              data-permission="org:update"
              data-state="unlocked"
              onClick={busy ? undefined : rename}
            >
              Rename org
            </button>
          ) : null}{' '}
          {canDelete ? (
            <button
              type="button"
              data-testid="delete-org"
              data-permission="org:delete"
              data-state="unlocked"
              onClick={busy ? undefined : remove}
            >
              Delete org
            </button>
          ) : null}
        </p>
      </div>
    </section>
  );
}

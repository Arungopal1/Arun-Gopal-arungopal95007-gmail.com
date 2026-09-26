// Grants: org-wide or device-scoped deltas over the role baseline.
// The permission catalogue is read live from the resolved session keys so
// it tracks whatever the server knows — documented or otherwise.
import React, { useEffect, useState } from 'react';
import { api, isAllowed, describeError } from '../api.js';

export default function Grants({ orgId, session }) {
  const [grants, setGrants] = useState(null);
  const [members, setMembers] = useState([]);
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [formUser, setFormUser] = useState('');
  const [formDevice, setFormDevice] = useState('');
  const [formEffect, setFormEffect] = useState('allow');
  const [formPerms, setFormPerms] = useState([]);
  const [busy, setBusy] = useState(null);

  const catalogue = Object.keys(session.permissions || {}).sort();

  async function load() {
    setError(null);
    try {
      const [g, m, d] = await Promise.all([
        api.get(`/orgs/${orgId}/grants`),
        api.get(`/orgs/${orgId}/members`),
        api.get(`/orgs/${orgId}/devices`),
      ]);
      const rows = g.grants || [];
      setGrants(rows);
      setMembers(m.members || []);
      setDevices(d.devices || []);
      const ids = (m.members || []).map((x) => x.userId || x.id);
      if (!formUser && ids.length > 0) setFormUser(ids[0]);
    } catch (err) {
      setError(err);
      setGrants([]);
    }
  }

  useEffect(() => {
    load();
  }, [orgId]);

  function togglePerm(key) {
    setFormPerms((prev) => (prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]));
  }

  async function submit(event) {
    event.preventDefault();
    setBusy('create');
    try {
      await api.post(`/orgs/${orgId}/grants`, {
        userId: formUser,
        deviceId: formDevice === '' ? null : formDevice,
        effect: formEffect,
        permissions: formPerms,
      });
      setFormPerms([]);
      await load();
    } catch (err) {
      window.alert(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id) {
    setBusy(`revoke:${id}`);
    try {
      await api.del(`/orgs/${orgId}/grants/${id}`);
      await load();
    } catch (err) {
      window.alert(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  if (grants === null && !error) {
    return (
      <section>
        <h2>Grants</h2>
        <p>Loading grants…</p>
      </section>
    );
  }

  const canCreate = isAllowed(session.permissions, 'grant:create');
  const canRevoke = isAllowed(session.permissions, 'grant:revoke');

  return (
    <section>
      <h2>Grants</h2>
      {canCreate ? (
        <button
          type="button"
          data-testid="new-grant"
          data-permission="grant:create"
          data-state="unlocked"
          onClick={() => setShowForm((v) => !v)}
        >
          New grant
        </button>
      ) : null}
      {error ? (
        <div role="alert" data-testid="grants-error">
          {describeError(error)}
        </div>
      ) : null}
      {showForm && canCreate ? (
        <form data-testid="grant-form" onSubmit={submit}>
          <label>
            User
            <select data-testid="grant-user" value={formUser} onChange={(e) => setFormUser(e.target.value)}>
              {members.map((m) => (
                <option key={m.userId || m.id} value={m.userId || m.id}>
                  {m.name || m.email} ({m.role})
                </option>
              ))}
            </select>
          </label>
          <label>
            Device
            <select data-testid="grant-device" value={formDevice} onChange={(e) => setFormDevice(e.target.value)}>
              <option value="">Whole org (all devices)</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Effect
            <select data-testid="grant-effect" value={formEffect} onChange={(e) => setFormEffect(e.target.value)}>
              <option value="allow">allow</option>
              <option value="deny">deny</option>
            </select>
          </label>
          <fieldset>
            <legend>Permissions</legend>
            {catalogue.map((key) => (
              <label key={key}>
                <input
                  type="checkbox"
                  data-testid="grant-permission"
                  data-permission-key={key}
                  checked={formPerms.includes(key)}
                  onChange={() => togglePerm(key)}
                />
                {key}
              </label>
            ))}
          </fieldset>
          <button data-testid="grant-submit" type="submit" disabled={busy === 'create'}>
            Create grant
          </button>
        </form>
      ) : null}
      <table data-testid="grants-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Device</th>
            <th>Effect</th>
            <th>Permissions</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {grants.map((g) => (
            <tr key={g.id} data-testid="grant-row" data-grant-id={g.id} data-effect={g.effect}>
              <td>{g.userId}</td>
              <td>{g.deviceId || 'all devices'}</td>
              <td>{g.effect}</td>
              <td>{(g.permissions || []).join(', ')}</td>
              <td>
                {canRevoke ? (
                  <button
                    type="button"
                    data-testid="revoke-grant"
                    data-permission="grant:revoke"
                    data-state="unlocked"
                    onClick={busy ? undefined : () => revoke(g.id)}
                  >
                    Revoke
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

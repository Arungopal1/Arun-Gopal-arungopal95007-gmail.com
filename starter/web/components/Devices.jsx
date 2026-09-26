// Device fleet. The list endpoint returns each visible row with its own
// resolved permission map, so every row-level button reads
// `device.permissions` — never the org baseline, never a role name.
import React, { useEffect, useState } from 'react';
import { api, isAllowed, describeError } from '../api.js';
import Action from './Action.jsx';

export default function Devices({ orgId, session }) {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/orgs/${orgId}/devices`);
      setDevices(data.devices || []);
    } catch (err) {
      setError(err);
      setDevices([]);
    }
  }

  useEffect(() => {
    load();
  }, [orgId]);

  async function startSession(device, mode) {
    setBusy(`${device.id}:${mode}`);
    try {
      await api.post(`/orgs/${orgId}/sessions`, { deviceId: device.id, mode });
      window.alert(`Session started on ${device.name} (${mode}).`);
    } catch (err) {
      window.alert(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function rename(device) {
    const name = window.prompt('Device name:', device.name);
    if (name === null || name.trim() === '') return;
    setBusy(`${device.id}:rename`);
    try {
      await api.patch(`/orgs/${orgId}/devices/${device.id}`, { name: name.trim() });
      await load();
    } catch (err) {
      window.alert(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function transferFile(device) {
    const path = window.prompt(`File to transfer with ${device.name}:`);
    if (path === null || path.trim() === '') return;
    window.alert(`File transfer queued on ${device.name}: ${path.trim()}`);
  }

  async function decommission(device) {
    if (!window.confirm(`Decommission ${device.name}? Its sessions will end.`)) return;
    setBusy(`${device.id}:decom`);
    try {
      await api.del(`/orgs/${orgId}/devices/${device.id}`);
      await load();
    } catch (err) {
      window.alert(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function addDevice() {
    const name = window.prompt('New device name:');
    if (name === null || name.trim() === '') return;
    const kind = window.prompt('Device kind (macos, windows, linux, android, ios):', 'linux');
    if (kind === null) return;
    setBusy('add');
    try {
      await api.post(`/orgs/${orgId}/devices`, { name: name.trim(), kind: kind.trim() });
      await load();
    } catch (err) {
      window.alert(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  if (devices === null && !error) {
    return (
      <section>
        <h2>Devices</h2>
        <p>Loading devices…</p>
      </section>
    );
  }

  const canProvision = isAllowed(session.permissions, 'device:provision');

  return (
    <section>
      <h2>Devices</h2>
      {canProvision ? (
        <button
          type="button"
          data-testid="add-device"
          data-permission="device:provision"
          data-state="unlocked"
          onClick={busy ? undefined : addDevice}
        >
          Add device
        </button>
      ) : null}
      {error ? (
        <div role="alert" data-testid="devices-error">
          {describeError(error)}
        </div>
      ) : null}
      {devices.length === 0 ? <p data-testid="devices-empty">No devices in this organization.</p> : null}
      {devices.length > 0 ? (
        <table data-testid="device-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => {
              const perms = d.permissions || {};
              return (
                <tr key={d.id} data-testid="device-row" data-device-id={d.id}>
                  <td>{d.name}</td>
                  <td>{d.kind}</td>
                  <td>{d.online ? 'online' : 'offline'}</td>
                  <td>
                    <Action
                      testid="start-view"
                      permission="device:view"
                      entry={perms['device:view']}
                      busy={busy}
                      onClick={() => startSession(d, 'view')}
                    >
                      View
                    </Action>{' '}
                    <Action
                      testid="start-control"
                      permission="device:control"
                      entry={perms['device:control']}
                      busy={busy}
                      onClick={() => startSession(d, 'control')}
                    >
                      Control
                    </Action>{' '}
                    <Action
                      testid="start-terminal"
                      permission="device:terminal"
                      entry={perms['device:terminal']}
                      busy={busy}
                      onClick={() => startSession(d, 'terminal')}
                    >
                      Terminal
                    </Action>{' '}
                    <Action
                      testid="rename-device"
                      permission="device:update"
                      entry={perms['device:update']}
                      busy={busy}
                      onClick={() => rename(d)}
                    >
                      Rename
                    </Action>{' '}
                    <Action
                      testid="transfer-files"
                      permission="device:file_transfer"
                      entry={perms['device:file_transfer']}
                      busy={busy}
                      onClick={() => transferFile(d)}
                    >
                      Transfer files
                    </Action>{' '}
                    <Action
                      testid="decommission-device"
                      permission="device:provision"
                      entry={perms['device:provision']}
                      busy={busy}
                      onClick={() => decommission(d)}
                    >
                      Decommission
                    </Action>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

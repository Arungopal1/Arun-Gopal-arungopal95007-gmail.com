// Org membership. Role changes, suspension and removal are gated on the
// resolved org entries; the only identity comparison is "is this me"
// (self rows get a plain label instead of the role editor).
import React, { useEffect, useState } from 'react';
import { api, isAllowed, describeError } from '../api.js';

export default function People({ orgId, session }) {
  const [members, setMembers] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/orgs/${orgId}/members`);
      setMembers(data.members || []);
    } catch (err) {
      setError(err);
      setMembers([]);
    }
  }

  useEffect(() => {
    load();
  }, [orgId]);

  async function invite() {
    const email = window.prompt('Invite email:');
    if (email === null || email.trim() === '') return;
    const role = window.prompt('Role for the invitee:', 'viewer');
    if (role === null || role.trim() === '') return;
    setBusy('invite');
    try {
      const data = await api.post(`/orgs/${orgId}/invites`, {
        email: email.trim(),
        role: role.trim(),
      });
      window.alert(`Invite created for ${data.email}. Token: ${data.inviteToken}`);
    } catch (err) {
      window.alert(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function changeRole(member, nextRole) {
    if (nextRole === member.role) return;
    setBusy(`role:${memberId(member)}`);
    try {
      await api.patch(`/orgs/${orgId}/members/${memberId(member)}`, { role: nextRole });
      await load();
    } catch (err) {
      window.alert(describeError(err));
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function suspend(member) {
    setBusy(`suspend:${memberId(member)}`);
    try {
      await api.post(`/orgs/${orgId}/members/${memberId(member)}/suspend`, {});
      await load();
    } catch (err) {
      window.alert(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function reinstate(member) {
    setBusy(`reinstate:${memberId(member)}`);
    try {
      await api.del(`/orgs/${orgId}/members/${memberId(member)}/suspend`);
      await load();
    } catch (err) {
      window.alert(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(member) {
    if (!window.confirm(`Remove ${member.name || member.email} from this org?`)) return;
    setBusy(`remove:${memberId(member)}`);
    try {
      await api.del(`/orgs/${orgId}/members/${memberId(member)}`);
      await load();
    } catch (err) {
      window.alert(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  if (members === null && !error) {
    return (
      <section>
        <h2>People</h2>
        <p>Loading people…</p>
      </section>
    );
  }

  const canInvite = isAllowed(session.permissions, 'user:invite');
  const canChangeRole = isAllowed(session.permissions, 'user:role:update');
  const canRemove = isAllowed(session.permissions, 'user:remove');
  const roleOptions = Array.from(new Set(members.map((m) => m.role).filter(Boolean))).sort();

  return (
    <section>
      <h2>People</h2>
      {canInvite ? (
        <button
          type="button"
          data-testid="invite-user"
          data-permission="user:invite"
          data-state="unlocked"
          onClick={busy ? undefined : invite}
        >
          Invite user
        </button>
      ) : null}
      {error ? (
        <div role="alert" data-testid="people-error">
          {describeError(error)}
        </div>
      ) : null}
      <table data-testid="people-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const id = memberId(m);
            const isSelf = id === session.user.id;
            const suspended = m.status === 'suspended';
            return (
              <tr key={id} data-testid="user-row" data-user-id={id} data-role={m.role}>
                <td>{m.name}</td>
                <td>{m.email}</td>
                <td>
                  {canChangeRole && !isSelf ? (
                    <select
                      data-testid="role-select"
                      data-permission="user:role:update"
                      data-state="unlocked"
                      value={m.role}
                      onChange={(e) => changeRole(m, e.target.value)}
                    >
                      {roleOptions.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span data-testid="role-label">{m.role}</span>
                  )}
                </td>
                <td>{m.status}</td>
                <td>
                  {canRemove ? (
                    suspended ? (
                      <button
                        type="button"
                        data-testid="reinstate-user"
                        data-permission="user:remove"
                        data-state="unlocked"
                        onClick={busy ? undefined : () => reinstate(m)}
                      >
                        Reinstate
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid="suspend-user"
                        data-permission="user:remove"
                        data-state="unlocked"
                        onClick={busy ? undefined : () => suspend(m)}
                      >
                        Suspend
                      </button>
                    )
                  ) : null}{' '}
                  {canRemove ? (
                    <button
                      type="button"
                      data-testid="remove-user"
                      data-permission="user:remove"
                      data-state="unlocked"
                      onClick={busy ? undefined : () => remove(m)}
                    >
                      Remove
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

function memberId(m) {
  return m.userId || m.id;
}

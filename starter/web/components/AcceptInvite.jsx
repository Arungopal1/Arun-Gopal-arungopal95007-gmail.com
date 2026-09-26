// Public invite redemption. No token is needed (or used) to peek at an
// invite, and a bad token renders only the error — never org content.
import React, { useEffect, useState } from 'react';
import { api, describeError } from '../api.js';

export default function AcceptInvite({ token, onAccepted }) {
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get(`/invites/${encodeURIComponent(token)}`);
        if (!cancelled) setInvite(data);
      } catch (err) {
        if (!cancelled) setError(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function accept(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post(`/invites/${encodeURIComponent(token)}/accept`, { name, password });
      await onAccepted();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (error) {
    return (
      <main className="invite-page">
        <h1>RemoteOps</h1>
        <div role="alert" data-testid="invite-error">
          {describeError(error)}
        </div>
      </main>
    );
  }

  if (!invite) {
    return (
      <main className="invite-page">
        <h1>RemoteOps</h1>
        <p>Loading invite…</p>
      </main>
    );
  }

  return (
    <main className="invite-page">
      <h1>RemoteOps</h1>
      <p>
        You are invited to join <strong>{invite.orgName}</strong>.
      </p>
      <form data-testid="invite-form" onSubmit={accept}>
        <p>
          Role: <span data-testid="invite-role">{invite.role}</span>
        </p>
        <label>
          Email
          <input data-testid="invite-email" type="email" value={invite.email} readOnly />
        </label>
        <label>
          Name
          <input
            data-testid="invite-name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            data-testid="invite-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button data-testid="invite-submit" type="submit" disabled={busy}>
          Accept invite
        </button>
      </form>
    </main>
  );
}

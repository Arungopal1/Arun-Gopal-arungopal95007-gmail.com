// Sign-in form. Failures are stated on screen in words; the message shown
// is always the server's, so wrong-password and unknown-account refuse
// identically and the console cannot become an enumeration oracle.
import React, { useState } from 'react';
import { api, describeError } from '../api.js';

export default function Login({ onSignedIn, initialError }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError || null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError({ code: 'VALIDATION', message: 'email and password are required' });
      return;
    }
    setBusy(true);
    try {
      await api.login(email.trim(), password);
      await onSignedIn();
    } catch (err) {
      // Stays visible until the next attempt replaces it.
      setError({ code: err.code || 'UNKNOWN', message: describeError(err) });
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <h1>RemoteOps</h1>
      <form data-testid="login-form" onSubmit={handleSubmit}>
        <label>
          Email
          <input
            data-testid="login-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            data-testid="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button data-testid="login-submit" type="submit" disabled={busy}>
          Sign in
        </button>
      </form>
      {error ? (
        <div role="alert" data-testid="login-error" data-error-code={error.code}>
          {error.message}
        </div>
      ) : null}
    </main>
  );
}

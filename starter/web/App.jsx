// Console shell: boot, org switching, and the permission-driven nav.
//
// Every card in the nav is gated on a resolved org-level entry from
// `session.permissions`. The admin card appears when the caller holds
// *either* org:update or org:delete, and its data-permission names the
// entry that granted presence.
import React, { useEffect, useState } from 'react';
import { api, isAllowed, describeError } from './api.js';
import Login from './components/Login.jsx';
import Devices from './components/Devices.jsx';
import People from './components/People.jsx';
import Grants from './components/Grants.jsx';
import Sessions from './components/Sessions.jsx';
import Audit from './components/Audit.jsx';
import Admin from './components/Admin.jsx';
import AcceptInvite from './components/AcceptInvite.jsx';

const NAV_DEFS = [
  { key: 'devices', label: 'Devices' },
  { key: 'people', label: 'People' },
  { key: 'grants', label: 'Grants' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'audit', label: 'Audit' },
  { key: 'admin', label: 'Admin' },
];

// Which org-level permission unlocks each card, and whether this session
// holds it. Pure functions of the resolved map — no role names involved.
function navGate(key, permissions) {
  switch (key) {
    case 'devices':
      return isAllowed(permissions, 'device:list') ? 'device:list' : null;
    case 'people':
    case 'grants':
      return isAllowed(permissions, 'user:read') ? 'user:read' : null;
    case 'sessions':
      return isAllowed(permissions, 'session:view') ? 'session:view' : null;
    case 'audit':
      return isAllowed(permissions, 'audit:read') ? 'audit:read' : null;
    case 'admin':
      if (isAllowed(permissions, 'org:update')) return 'org:update';
      if (isAllowed(permissions, 'org:delete')) return 'org:delete';
      return null;
    default:
      return null;
  }
}

function inviteTokenFromPath() {
  const match = /^\/invite\/([^/]+)\/?$/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function toSession(payload) {
  return {
    org: payload.org,
    user: payload.user,
    role: payload.role,
    orgs: payload.orgs || [],
    permissions: payload.permissions || {},
  };
}

export default function App() {
  const [inviteToken, setInviteToken] = useState(() => inviteTokenFromPath());
  const [session, setSession] = useState(null);
  const [boot, setBoot] = useState(() =>
    inviteTokenFromPath() ? { loading: false, error: null } : { loading: true, error: null },
  );
  const [view, setView] = useState('devices');

  // Boot: the token is gone on reload, so restore via the refresh cookie
  // and then resolve the full session. A bare 401 means "signed out".
  useEffect(() => {
    if (inviteTokenFromPath()) return;
    let cancelled = false;
    (async () => {
      try {
        const refreshed = await api.refresh();
        if (!refreshed) {
          if (!cancelled) setBoot({ loading: false, error: null });
          return;
        }
        const me = await api.me();
        if (!cancelled) {
          setSession(toSession(me));
          setBoot({ loading: false, error: null });
        }
      } catch (err) {
        if (cancelled) return;
        if (err && err.status === 401) {
          setBoot({ loading: false, error: null });
        } else {
          setBoot({ loading: false, error: err });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSignedIn() {
    const me = await api.me();
    setSession(toSession(me));
    setView('devices');
  }

  async function handleSwitchOrg(orgId) {
    await api.switchOrg(orgId);
    const me = await api.me();
    setSession(toSession(me));
    setView('devices');
  }

  async function handleRefreshSession() {
    const me = await api.me();
    setSession(toSession(me));
  }

  async function handleCreateOrg() {
    const name = window.prompt('New organization name:');
    if (name === null || name.trim() === '') return;
    try {
      const created = await api.post('/orgs', { name: name.trim() });
      await handleSwitchOrg(created.id);
    } catch (err) {
      window.alert(describeError(err));
    }
  }

  function handleLogout() {
    api.logout();
    window.location.reload();
  }

  async function handleInviteAccepted() {
    window.history.replaceState(null, '', '/');
    setInviteToken(null);
    setBoot({ loading: false, error: null });
  }

  // Invite links short-circuit the whole shell.
  if (inviteToken) {
    return <AcceptInvite token={inviteToken} onAccepted={handleInviteAccepted} />;
  }

  if (boot.loading) {
    return (
      <main className="boot-page">
        <p>Loading…</p>
      </main>
    );
  }

  if (!session) {
    return <Login onSignedIn={handleSignedIn} initialError={boot.error} />;
  }

  const permissions = session.permissions;
  const visibleNav = NAV_DEFS.map((n) => ({ ...n, permission: navGate(n.key, permissions) })).filter(
    (n) => n.permission !== null,
  );
  const active = visibleNav.some((n) => n.key === view) ? view : visibleNav[0].key;

  return (
    <div
      className="app-shell"
      data-testid="app-shell"
      data-org-id={session.org.id}
      data-org-theme={session.org.theme}
    >
      <header className="app-header">
        <div className="org-identity">
          <strong>{session.org.name}</strong>{' '}
          <span data-testid="active-role">{session.role}</span>
        </div>
        <div data-testid="org-switcher" className="org-switcher">
          {session.orgs.map((o) => (
            <button
              key={o.id}
              type="button"
              data-testid="org-option"
              data-org-id={o.id}
              data-org-theme={o.theme}
              aria-current={o.id === session.org.id ? 'true' : undefined}
              onClick={() => {
                if (o.id !== session.org.id) handleSwitchOrg(o.id).catch((e) => window.alert(describeError(e)));
              }}
            >
              {o.name}
            </button>
          ))}
          <button type="button" data-testid="create-org" onClick={handleCreateOrg}>
            New org
          </button>
        </div>
        <button type="button" data-testid="logout" onClick={handleLogout}>
          Sign out
        </button>
      </header>
      <nav className="app-nav">
        {visibleNav.map((n) => (
          <button
            key={n.key}
            type="button"
            data-testid={`nav-${n.key}`}
            data-permission={n.permission}
            data-state="unlocked"
            aria-current={n.key === active ? 'page' : undefined}
            onClick={() => setView(n.key)}
          >
            {n.label}
          </button>
        ))}
      </nav>
      <main className="app-main" key={`${session.org.id}:${active}`}>
        {active === 'devices' ? <Devices orgId={session.org.id} session={session} /> : null}
        {active === 'people' ? <People orgId={session.org.id} session={session} /> : null}
        {active === 'grants' ? <Grants orgId={session.org.id} session={session} /> : null}
        {active === 'sessions' ? <Sessions orgId={session.org.id} session={session} /> : null}
        {active === 'audit' ? <Audit orgId={session.org.id} session={session} /> : null}
        {active === 'admin' ? (
          <Admin orgId={session.org.id} session={session} onOrgChanged={handleRefreshSession} />
        ) : null}
      </main>
    </div>
  );
}

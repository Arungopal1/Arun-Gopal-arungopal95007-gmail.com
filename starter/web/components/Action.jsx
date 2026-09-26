// A single permission-gated button.
//
// Presence semantics: when the server-resolved entry for this scope is not
// `allow`, nothing is rendered at all — no disabled state, no placeholder.
// Otherwise the button carries its permission key and the unlocked marker.
import React from 'react';

export default function Action({ permission, entry, onClick, children, busy, testid }) {
  if (!entry || entry.effect !== 'allow') return null;
  return (
    <button
      type="button"
      data-testid={testid}
      data-permission={permission}
      data-state="unlocked"
      onClick={busy ? undefined : onClick}
    >
      {children}
    </button>
  );
}

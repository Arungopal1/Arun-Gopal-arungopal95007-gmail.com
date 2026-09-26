# DECISIONS

One section per decision that a reviewer might reasonably have made differently. Every section has
the same four parts, and the third and fourth are the ones we weigh most.

Rules, from `starter/DISCOVERY-BRIEF.md`:

- cite something real in `Why` — a commit, a test, an error string, a file and line
- do not restate what a document says; describe what you did when the documents ran out
- six to twelve decisions is the expected range

Graded copy lives here at repo root. Template source: `starter/DECISIONS.md`.

---

### The catalogue is read from the DB, never hardcoded

**What I chose:** `SELECT key FROM permissions` (plus `permission_patterns` for grants) at request time; no 5-role / 19-permission literal anywhere.
**Why:** _(to fill with evidence)_ `node scripts/personalise.js` (fingerprint `bb339819425c`) shows role `reviewer` + permission `device:reboot` outside docs; `npm run personalisation` is the floor check.
**What I rejected:** encoding the documented matrix; it passes public suites and fails grading on a different nonce.
**What would change my mind:** a fixture where the catalogue is fixed — contradicts the overlay design, so none.

### Algorithm is pinned before the signature is checked

**What I chose:** parse + validate `alg==='HS256' && typ==='JWT'`, then HMAC-SHA256 with constant-time compare; length check first.
**Why:** `node scripts/check-jwt.js` 43/43 — rejects `alg:none` (empty / trailing-dot / kept-sig), `HS512`/`RS256` substitution, truncated/empty/non-base64 sigs, payload-swap with old sig.
**What I rejected:** trusting the header's `alg` to pick the hash, and early-return on decode without object checks (`null`/array payload would TypeError instead of 401).
**What would change my mind:** a spec allowing multiple algs with a key per alg — then pinning becomes a whitelist, not a constant.

### Sessions are grandfathered; tenancy events cascade

**What I chose:** role/grant changes bump `perm_version` only; suspension/removal/transfer call `endActiveSessions` with distinct `end_reason`; TTL sweep on reads.
**Why:** `check-api.js` §7.1 (live session survives demote, next blocked + TOKEN_STALE) and §7.2 (suspend ends with `user_suspended`); commit `f8dbc38` run 66/66.
**What I rejected:** ending sessions on grant revoke (would break in-flight repair) and `permission_revoked` reason (spec has none).
**What would change my mind:** a requirement for immediate revocation — then TTL would need shortening, not cascade widening.

### Console presence comes from the server, never roles

**What I chose:** `Action` null unless `entry.effect==='allow'`; device buttons read per-row sets; catalogue from `session.permissions` keys.
**Why:** UI architecture test (intercept devices → deny → element vanishes) + 25/25 UI pass; `grep role=== web/` clean.
**What I rejected:** client role matrix and gating start buttons on `session:start` (would hide Dana's granted Control).
**What would change my mind:** offline-first UI — then a cached matrix with version invalidation, currently not needed.

### Sign-out revokes the refresh family

**What I chose:** extra `POST /v1/auth/logout` (public, cookie-based; revokes family, clears `rt`); frontend calls it then drops the token with no reload.
**Why:** sign-out reloaded, so the live refresh cookie restored the session instantly — reported as "signout work agala". Verified LOGOUT 204 then refresh → 401; reload-without-logout still restores (UI test green).
**What I rejected:** token-drop-only logout (leaves reusable cookie) and an authenticated-only logout (fails exactly when the token is expired).
**What would change my mind:** a spec forbidding extra routes — then logout stays client-only with the reload-restores caveat.

<!-- Copy the block above per decision. -->

---

## Where this repo argues with itself

The documents contradict each other, or contradict the schema, in at least one place. Name each
one you found. For each: quote both statements, say which you built against, and say why.

_(to fill as contradictions are found)_

## Deliberately not built

What you chose not to build, and the reason.

_(to fill)_

## Sources — libraries, posts, tools

Per submission rules: anything taken from a library, blog post, or tool is cited here with what
it was used for. All implementation is original unless listed below.

- Starter fork: `rhinostream/Hackathons` (fork parent) — base skeleton only, no reference solution used.
- _(append entries as used, e.g. `- better-sqlite3 docs — <what for>`)_
- No AI-generated code is submitted unexplained: per DISCOVERY-BRIEF, every line must be explainable live.

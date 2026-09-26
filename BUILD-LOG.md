# BUILD-LOG

Append to this as you go. Commit it with the code it describes — the timestamps are part of the
evidence, and a log that arrives in one commit at the end reads as what it is.

Five lines is a real entry. Short and dated is better than long and reconstructed.

The categories we look for are listed in `starter/DISCOVERY-BRIEF.md`.

---

## 2026-09-26 · Phase 0 — orientation (repo root log started)

Forked `rhinostream/Hackathons` to `Arungopal1/Arun-Gopal-arungopal95007-gmail.com` and cloned locally.
Read `starter/DISCOVERY-BRIEF.md` before writing code: log must grow per-phase in its own commits,
DECISIONS must cite evidence + rejected alternative.
Created this root `BUILD-LOG.md` + root `DECISIONS.md` on day 0 so `git log --follow` shows growth,
not a last-day story. Starter templates remain in `starter/`; graded copies live here at root.

## Phase 0 — orientation

_Installed, reset the database, read the documents, ran the suites against the untouched skeleton.
What did the starting line actually look like, and which failure surprised you?_

2026-09-26: Ran `node scripts/personalise.js` in `starter/` (nonce `starter-demo`, fingerprint
`bb339819425c`). Overlay is role `reviewer` (rank 35), permission `device:reboot`, org `Ironside
Labs (org_p_bb3398)` — none in docs. Confirms: engine must read `permissions` /
`permission_patterns` / `role_permissions` at runtime, never hardcode 5×19 matrix. Grading uses a
different nonce, so special-casing this draw fails.

## Phase 1 — token verification

_What did you expect each failure mode to look like before you ran it? Which one behaved
differently from your expectation, and what did that tell you?_

2026-09-26: Implemented `verifyAccessToken` in `starter/server/auth.js`. Expected the stub to fail
everything (it did — 0/43 shape-checks). Prediction that was wrong: assumed `Buffer.from(x,
'base64url')` throws on `!!!not-base64!!!`; it returns short bytes instead, so length check +
`timingSafeEqual` is what rejects it, not the decode. Also added explicit object checks for header
/ payload (`null` / array / string) so a crafted `null` payload becomes 401, not a TypeError.
`node scripts/check-jwt.js`: ALL PASS 43/43.

## Phase 2 — caller context and the resolution engine

_This is where most people's first model is wrong. Write down the model you started with, the
observation that broke it, and the model you moved to. Be specific about the observation._

2026-09-26: Started with precedence-by-specificity instinct (device-scoped allow should carve out
org-wide deny). `check-permissions.js` discriminating case says otherwise: org-wide deny +
device allow on same device still `deny`. Moved to deny-first combine: collect denies, then
baseline + allows, then implicit. Org-level (`deviceId null`) unions ALL grants including
device-scoped (nav lights up if any row allows); per-device filters to org-wide + that device.
Half-open windows `starts<=now<expires` in SQL. `resolveDevices` batches: catalogue/membership/
baseline once + one grants query, in-memory per-row filter — no N+1, no cache so no stale
authority. Suspended short-circuits to `suspended` (freshness skipped in context so 403 survives);
no membership to `not_a_member`. Checks: `check-permissions.js` 35/35, `check-personalisation.js`
18/18 (role `reviewer`, perm `device:reboot`).

## Phase 3 — orgs, members, invites

_Anything you had to work out that no document states. Invite lifecycle states are a common
source of this._

2026-09-26: Auth routes (login/token/refresh/me) + orgs/members/effective/audit + invites done.
Invite atomic claim via `UPDATE ... WHERE accepted NULL AND revoked NULL` (changes===1 wins);
existing user attach (no duplicate), invited→active + bump, removed→reactivate. Peek leaks only
orgName/role/email. Tested via `check-api.js` invites block in rtest copy (Windows loader patched
there only): 11/11 invite assertions pass.

## Phase 4 — devices and grants

_What happens at the boundary where two grants disagree, or where a grant's scope and the
question's scope differ? Say what you predicted and what you got._

2026-09-26: Device CRUD scoped by org (cross-org 404), per-row `device:view` exclusion, batched
`resolveDevices` for list. Grants validate 404s before `assertMayGrant` (cross-org stays invisible),
unknown pattern reaches FK → 400 `unknown_permission`, self-grant 403. Transfer needs provision in
both orgs, drops device-scoped grants, cascades sessions. `check-api.js` in rtest: ALL PASS 66/66
(with overlay loaded: 3 orgs, 20 perms).

## Phase 5 — sessions

_Two permissions, one device. What did you have to resolve, and in what order, to keep the two
failure reasons distinguishable?_

2026-09-26: `assertCanStartSession` checks `session:start` first (`missing_permission`), then the
mode perm (`missing_device_permission`) — both on the same deviceId. Exclusivity via partial unique
index (DB arbiter, not check-then-act); `view` excluded. Grandfathering: role/grant changes bump
`perm_version` (next request 401 stale) but never end sessions; suspension/removal/transfer cascade
with `user_suspended`/`membership_removed`/`device_transferred`. TTL sweep before reads.

## Phase 6 — audit

_What did you decide counts as an auditable event, and what pushed you to that line?_

2026-09-26: Success rows inside the mutation transaction (exactly one); `auditDenials` records
FORBIDDEN denials with reason before rethrow. Denied GETs also flow through where gated (audit of
`session:view` etc. visible in `check-api` denials assertion). Append-only enforced by triggers.

## Phase 7 — the console

_Where did the server's answer and your instinct disagree about what should be on screen?_

2026-09-26: Built server-driven presence: `Action` returns null unless `entry.effect==='allow'`;
no `role===` in web/. Device rows carry per-row sets; start buttons gate on the device perm alone
(Dana viewer + `device:control` grant on one Globex row must show Control there). Org theme drives
`backgroundColor` so switching measurably changes appearance. `vite build` 39 modules. UI suite in
rtest copy (Windows-only loader/DIST path fixes there, repo files unchanged): 25/25 passed.

## Phase 8 — hardening

_What did you measure, what did you fix, and what did you deliberately leave alone? Anything you
chose not to build belongs here with its reason._

2026-09-26: `resolveDevices` batches (1 grants query + in-memory filter, no cache → no stale
authority). Full green: check-jwt 43/43, check-permissions 35/35, personalisation 18/18,
check-api 66/66 (overlay loaded), UI 25/25. Left out: pagination beyond audit, device search,
password reset, real remote access (records only) — scope cuts per BRIEF.

## Open threads

_Things you know are wrong, unfinished, or that you would do differently with another day._

2026-09-26 (sign-out fix): Sign out reloaded the page, so the valid refresh cookie immediately
restored the session — looked like logout did nothing. Added `POST /v1/auth/logout` (public,
cookie-based; revokes the refresh family, clears `rt` with Max-Age=0; no-cookie → 204). Frontend
`api.logout()` now calls it (best-effort) then drops the in-memory token with no reload.
Verified: LOGOUT 204, refresh-after-logout 401; `check-api.js` 66/66 and reload-restores test still
pass (reload without logout still restores).

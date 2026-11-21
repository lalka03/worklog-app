# Offline remembered sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open personal worklogs and save shifts on a disconnected Android device during its existing remembered session, then sync only after online revalidation.

**Architecture:** The server returns the fixed absolute refresh expiry. The existing Keystore-backed atomic file stores a versioned grant alongside the rotating refresh token. The JS API distinguishes offline identity from fully authorized access, and the UI uses the existing UID-scoped sync cache without fetching administrator data until verification succeeds.

**Tech Stack:** Python/YDB, JavaScript/Node tests, Capacitor 6 Android Java/Keystore, existing GitHub Actions signed APK.

**Spec:** `docs/superpowers/specs/2026-11-21-offline-remembered-session-design.md`

## Global Constraints

- 30 days maximum from original remembered login; renewal cannot extend it. Non-remembered login unchanged. No saved password or access token on disk. No new cloud resources or database schema changes.
- Existing #32 credential upgrades on successful online renewal; a legacy credential alone cannot permit an offline launch. Keep package ID `com.worklog.app.yandex.test`, signing key, and existing per-UID cache names.
- Offline access is limited to personal worklog, settings and totals. No employee data, invitations or admin mutations. Preserve existing queue, revisions, conflict handling, drafts and account isolation.
- Expired, explicitly rejected, malformed or mismatched identities must not unlock the offline grant. Connectivity errors may use a valid grant; auth rejection must not. Remote revocation is only knowable after contacting the server.
- Server and signed APK deployment are separate from local verification; do not replace production resources or publish to stores.

## Review Focus

- Legacy token-only file and upgraded API during rolling deployment: online login works, offline fails closed until a real grant is written (tasks 2–3).
- Expiry or clock rollback while open, during backgrounding, and at launch: lock local data, do not drop pending work (tasks 3–4).
- Logout or switched account racing with connectivity recovery: stale responses must never bind or send another account's data (tasks 3–4).
- Admin data already visible at disconnection, including delayed responses: discard it, clear selection and prevent reopening (task 4).
- Lost server response during renewal and stale worklog revisions: keep draft, do not silently overwrite or fall back after 401 (tasks 3–4).

---

### Task 1: Authoritative expiry in auth responses

**Files:** `backend/service.py`, `backend/tests/test_auth.py`, `backend/tests/test_http.py`.

**Interfaces:** Add `refreshExpiresAt: str` and `serverTime: str` to `AuthResult`, both UTC ISO timestamps. `_auth_result(account, access, refresh, session, now)` receives the same server time used for login or renewal. Keep `expiresAt` (access expiry) and previous fields unchanged.

- [ ] Test: in fixed-clock remembered login, `refreshExpiresAt == utc_timestamp(start + REMEMBER_SECONDS)`, `serverTime == utc_timestamp(start)`, renewal after a day preserves the former and advances the latter; ordinary login returns its shorter expiry. HTTP tests assert both new fields and original fields, without changing accepted body parameters.
- [ ] Run `python -m unittest discover -s backend/tests -v`; confirm the added assertions fail because the fields are absent.
- [ ] Implement the two fields and pass `now` from `_insert_session`/`renew`; no change to expiration checks or schema.
- [ ] Run the backend suite; all non-integration tests pass and pre-existing environment-dependent skips are documented.
- [ ] Commit task 1.

### Task 2: Versioned protected native records

**Files:** `native/android/RememberedSessionPlugin.java`, `test/pilot-build.test.cjs`, `index.html` native bridge only.

**Interfaces:** Native `get()` returns `{token: string|null, grant?: object}`. `set({token, grant?})` accepts a legacy token or a grant `{version:1,user:{uid,email,role},refreshExpiresAt,serverTime,verifiedLocalMs,checkedLocalMs}`. `clear()` removes both atomically. The JS adapter `get()` returns `null`, legacy string, or `{token,grant}`; `set(value)` accepts the same string/record shapes. `grant` has neither password nor access token.

- [ ] Add staging/bridge tests for legacy compatibility, one authenticated ciphertext carrying all fields, bounded ciphertext (at most 4096 plaintext bytes plus nonce/tag), malformed records rejected, atomic read/write and existing package/Keystore/no-backup requirements. Include an Android device test procedure for migration and clear; Node tests must not pretend to actually run Android cryptography.
- [ ] Run `node --test test/pilot-build.test.cjs`; confirm grant-specific assertions fail.
- [ ] Extend existing encrypted plaintext format: legacy regex token or exact versioned JSON object, using existing key and file. Reject unknown/invalid structures; validate field types, string lengths, grant timestamps and UID; use the same authenticated ciphertext and atomic write/readback. Legacy plaintext remains readable. Adapt JS bridge without exposing credentials via web storage.
- [ ] Rerun staging tests, compile via the normal signed build at task 5, and keep manual migration/decryption/logout checks explicit.
- [ ] Commit task 2.

### Task 3: API offline identity and revalidation

**Files:** `api.js`, `test/api.test.cjs`.

**Interfaces:** Existing `login`, `restore`, `logout`, and `renew` return types remain compatible. Add `isOffline(): boolean`, `offlineValid(): boolean`, `enterOffline(): Promise<user|null>`, `checkpointOffline(): Promise<boolean>` and `reconnect(): Promise<user|null>` to API. `create` accepts `now=Date.now` for deterministic expiry tests. API tracks a private grant separately from active online tokens; local user identity is returned by `restore()` on `network`/`timeout` only if the grant is valid. `enterOffline` makes an existing remembered session local-only and clears active online authorization; it returns null for a non-remembered session without altering it. `checkpointOffline` validates and persists the nondecreasing clock high-water mark, or locks the offline session on failure. `authorized` refuses all requests while offline; `reconnect` is single-flight, renews saved token and checks same UID, establishes online tokens only on valid response and successful protected persistence. No fallback on any 401/403 or malformed response. Expose grant expiry check without exposing token.

- [ ] Test: remembered login writes encrypted-store-shaped record, no access token/password; offline restart with `now` before deadline yields same UID but forbids GET/PUT/admin; legacy and expired grants stay locked; missing/malformed expiry response stores legacy token only, never creates an offline grant; update/rollback of local clock cannot extend the original server deadline. Assert `remaining = parsed(refreshExpiresAt) - parsed(serverTime)` is positive and at most 30 days; local deadline is the earlier of server absolute expiry and `verifiedLocalMs + remaining`; local time before `checkedLocalMs` fails closed. Keep a persisted high-water clock check on offline reopen/periodic checks (serialized protected write without token rotation).
- [ ] Test: disconnected edit is held locally; reconnect sends renew only, successful same-UID response allows protected calls and preserves fixed expiry; wrong UID, revoked or expired 401 never opens, clears saved grant; transient failure retains identity and retry; concurrent reconnect shares one renewal; logout generation wins over a delayed renew; storage failure does not expose private data. Keep existing online/ordinary-login tests.
- [ ] Run `node --test test/api.test.cjs`; verify the new cases fail for missing offline grant/API behavior.
- [ ] Implement grant validation, storage migration, offline state and revalidation using the existing storage queue/generation mechanisms. `reconnect` must distinguish stale/unauthorized states from transient network errors. For a local grant, advance persisted high-water on successful periodic check or offline reopen; no write after generation change. Fail closed if storage validation fails. Use the server result to update verified role only after returning online.
- [ ] Rerun the API tests and commit task 3.

### Task 4: Personal-only offline UI and existing sync

**Files:** `index.html`, `test/account-integration.test.cjs`, `test/sync.test.cjs` (if integration needs an added conflict test).

**Interfaces:** `bindAccount(user)` binds UID-scoped sync regardless of offline state, with `isAdmin=false` for offline UI only. `runSync(current)` verifies `api.reconnect()` before any protected sync if offline; only same-generation same-UID response re-enables admin. `saveDB`, foreground handler, render and scheduled check lock the view when `api.offlineValid()` fails in offline mode; foreground/periodic checks call `api.checkpointOffline()` while offline. The disconnect handler immediately clears admin state and calls `api.enterOffline()`, using a generation check before any UI update. `syncAvailable()` and admin action guards prevent network work/employee data while offline; the scheduler may still attempt `reconnect` when connectivity returns. Distinguish pending/local-only and verified statuses. Copy: «Без интернета. Изменения сохраняются на устройстве.» and, after upload, existing «Данные синхронизированы.».

- [ ] Extend VM app harness with live connectivity, fake clock, mutable renewal response, protected grant record, event/timer triggers and cache reuse across launches. Test legacy offline lock (existing), valid offline cold start reads only own UID's saved shifts and can save a new shift; no remote calls while offline. After reconnect, calls start with renew before PUT and preserve revision, local cache is unchanged when remote revision conflicts. Offline admin hides employee tab and rejects direct admin render/actions; clear previous employee list and late replies. Switching/logging out, failed storage clear, expiry while foreground or background, rollback, and 401 keep personal draft scoped and lock old UID. Ensure no automatic sign-out merely because network failed.
- [ ] Run `node --test test/account-integration.test.cjs test/sync.test.cjs`; confirm the newly requested behavior fails in #32.
- [ ] Implement UI offline identity binding, expiry guards, status, event/retry ordering and admin gating using task 3 API. Preserve active forms on successful reconnect where possible; do not reinitialize/lose pending edits. Do not refresh protected data or reveal staff data until online verification. For already online remembered users, on disconnect disable admin and use the same protected grant; non-remembered active sessions retain existing personal offline behavior but cannot cold-start offline.
- [ ] Run API, account integration, sync and full Node suite; commit task 4.

### Task 5: Verification, rollout and handset acceptance

**Files:** `README.md`, `cloud/README.md`, existing GitHub workflow and APK verification script (no new cloud resources).

- [ ] Document update flow: deploy backward-compatible backend first; retain prior Cloud Function version; user installs the same signed package over #32, opens online once, then tests offline cold start, edits, reconnect, deletes test shift and verifies synced removal. Do not uninstall or clear app data. Include known offline revocation/clock limitations and logged-out behavior.
- [ ] Run `python -m unittest discover -s backend/tests -v`, `npm test`, `git diff --check`. Review all changed authorization and storage boundaries; resolve any security regressions before release.
- [ ] After authorized rollout, update only the existing private pilot API (no schema changes), verify old/new auth contract with designated test account and preserve data. Push reviewed branch, trigger signed build via GitHub Actions, verify run succeeded, signed APK package/version/certificate match existing #32 and expected frontend contents. Provide APK only after successful checks; label phone acceptance pending until user verifies.
- [ ] Confirm device results and retain previous APK/server version for rollback; never delete real shifts or legacy backups during testing.

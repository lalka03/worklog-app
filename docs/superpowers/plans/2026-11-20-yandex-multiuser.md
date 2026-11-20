# Worklog Yandex Multiuser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An independently installable Worklog pilot with a Yandex-backed account and worklog API, single-use invitations, read-only admin employee views, recoverable synchronization and private backups.

**Architecture:** API Gateway invokes a private Python function using its assigned service account; all application authorization happens server-side. YDB is the authoritative transactional store, a separate function exports private backup snapshots; the Capacitor client keeps its existing worklog UI and uses a new HTTP transport instead of Firebase.

**Tech Stack:** Python 3.12, YDB Python SDK, Argon2id (`argon2-cffi`), unittest, JavaScript/Node 20, Capacitor 6, Android SDK 34/Java 17, GitHub Actions, Yandex API Gateway, Cloud Functions, Object Storage.

**Spec:** `docs/superpowers/specs/2026-11-20-yandex-multiuser-design.md`

## Global Constraints

- Only `worklog-yandex-test`; base build #28, f0eb93b7d053b2d8b75685ee273dbed4abfa6d06. Never modify `main`, `worklog-multiuser-test`, existing Firebase projects, or existing private backup function.
- Android ID `com.worklog.app.yandex.test`, label `Worklog Yandex Test`, distinct artifact. Existing #28 remains independently installed and usable. Only synthetic test data before acceptance; no automatic account/data migration or app stores.
- Server-side sole authority for identity and role; admin writes own records only, reads colleagues' records only. Invitation default seven days, one-use, at least 128 random bits, revocable; no plaintext invitations/sessions/passwords persisted. Admin assignment exclusively out of band; open registration disabled by default.
- HTTPS; private app function, narrowly scoped gateway invoker and DB identities, separate backup writer. No static cloud secrets in APK/git/logs. 30-day backup rotation; no active sessions or usable reset codes in backup. Review billing/quotas before hosted provisioning; deployment and real-data import require owner approval.
- Preserve JSON version 1 and current calculator/UI semantics, local account isolation, explicit stale-write recovery. UTC timestamps server-side. No Firebase traffic from Yandex APK.

## File Structure

- `backend/schema.yql`: declarative YDB tables/indexes.
- `backend/store.py`: repository contract and serializable YDB implementation, bounded retry for transient failures.
- `backend/security.py`: key derivation/validation, token generation/digests, auth policy and limits.
- `backend/service.py`: account, invite, recovery, worklog and admin business operations.
- `backend/index.py`: private function HTTP interface, validation, CORS, response and error mapping.
- `backend/backup.py`: separate private snapshot/restore tooling and manifest.
- `backend/requirements.txt`, `backend/tests/`: pinned dependencies and test harness, fake storage for fast tests plus real YDB integration suite.
- `cloud/gateway.yaml`, `cloud/README.md`: constrained gateways, roles, deployment and recovery procedure; no resource creation from CI.
- `api.js`: client transport and authentication lifecycle; `sync.js`: per-user cache, revision/pending/conflict state machine.
- `index.html`, `account.js`, `capacitor.config.json`: preserve current UI, bind new auth and sync, add invite management; adapt prior account tests.
- `test/api.test.cjs`, `test/sync.test.cjs`, `test/account-integration.test.cjs`, `test/account.test.cjs`: client and UI regression tests.
- `.github/workflows/build-apk.yml`, `README.md`: safe build and pilot setup, test commands, artifact and deployment gate.

## Review Focus

- Lost response after successful save: retry same mutation ID yields original revision, no duplicate or unintended overwrite (Task 2).
- Simultaneous use of same invite: exactly one account created; losers cannot authenticate (Task 1).
- Expired session or logout while a request is in flight: response cannot modify next user's cache (Task 3).
- Offline edits on two devices: stale write returns 409, preserves local draft and requires explicit recovery (Task 3).
- Restoring old backup must not reopen already-used invitations or resurrect sessions (Task 4).

---

### Task 1: Transactional account and invitation core

**Files:** `backend/schema.yql`, `backend/store.py`, `backend/security.py`, `backend/service.py`, `backend/requirements.txt`, `backend/tests/test_auth.py`, `backend/tests/test_ydb.py`, `backend/tests/fake_store.py`.

**Interfaces:** `Store.run_write(fn)` serializable read-write transaction; `Store.run_read(fn)` consistent read. Transaction adapter provides typed account-by-email/id, invitation-by-digest, session-by-digest, reset-by-digest, worklog-by-uid, mutation and rate-bin operations; `service.Service(store, clock, tokens)` exposes `register(email,password,invite) -> AuthResult`, `login(email,password,ip) -> AuthResult`, `renew(refresh_token) -> AuthResult`, `authenticate(access_token) -> Principal`, `logout(access_token)`, `create_invite(principal) -> InviteResult`, `list_invites(principal)`, `revoke_invite(principal,invite_id)`, `issue_reset(principal,uid)`, `redeem_reset(code,new_password)`. Principal is `{uid,email,role}`; AuthResult is `{user,accessToken,refreshToken,expiresAt}`. InviteResult is `{id,code,expiresAt}`; list excludes code. Expected domain errors carry stable `code` and HTTP status. Clock injects UTC epochs; token factory uses OS CSPRNG by default.

- [ ] Write red tests `test_register_consumes_invite`, `test_parallel_register_only_one_wins`, `test_duplicate_email_preserves_invite`, `test_expired_and_revoked_invites`, `test_worker_cannot_create_invite`, `test_admin_not_assignable_by_client`, `test_reset_revokes_sessions`, `test_renewal_rotation`, `test_rate_limit`, `test_no_secret_in_records`. Assert used invite cannot register another account, a failed duplicate email leaves new invite unused, only admin can create codes, registration role defaults to employee, expired/revoked tokens fail, passwords never equal stored hash, and refresh token digest is not token. Real YDB concurrent integration validates one committed registration with a shared invite.
- [ ] Run `python -m unittest discover -s backend/tests -p 'test_auth.py' -v`; expect missing modules/failure.
- [ ] Implement schema primary keys and unique email lookup table (normalized trimmed lowercase email stored only once via transactional insert); UUID accounts; invite digest indexed by digest with ID, issuer, expiry, state; sessions, reset tokens, rate bins; worklogs, mutations and audit tables. Store consumes typed keys only; no query string interpolation. Hash passwords using Argon2id, validate 12–128 character password, no trimming, cryptographically random base64url token 128+ bits, digest tokens SHA-256; default invites seven days; access 15 min, refresh max seven days; rotate refresh atomically and revoke on logout/reset. Bootstrap only via operator script/privileged process, no public bootstrap endpoint, no hardcoded owner email. Reset is one-use, expires after one hour; admin privately verifies identity; passwords never revealed. Rate-limit auth attempts per trusted gateway IP and normalized email (10 attempts/15 minutes each); limiter survives transaction failures and returns 429; use generic login and invite errors.
- [ ] Run auth unit tests; `WORKLOG_YDB_ENDPOINT` and `WORKLOG_YDB_DATABASE` pointing exclusively to isolated test DB enable `python -m unittest discover -s backend/tests -p 'test_ydb.py' -v`; concurrency tests must pass before public endpoint. No real hosted resource setup without gate. Commit tested unit core with actual integration status.

### Task 2: Worklog API, authorization and concurrency

**Files:** `backend/service.py`, `backend/index.py`, `backend/tests/test_worklog.py`, `backend/tests/test_http.py`, `backend/tests/test_ydb.py`, `cloud/gateway.yaml`.

**Interfaces:** `Service.get_worklog(principal) -> {data,revision}`, `put_worklog(principal,data,expected_revision,mutation_id) -> {revision,updatedAt}`, `list_employees(principal) -> {users}`, `get_employee(principal,uid) -> {profile,worklog}`. `data` is version-one settings/days JSON; null initial snapshot has revision 0. Employee objects are keyed UID with `profile.email`, `worklog` compatible with current `employeeRows`. HTTP routes JSON: `POST /auth/register`, `/auth/login`, `/auth/renew`, `/auth/logout`, `/auth/reset`; `GET /me/worklog`, `PUT /me/worklog` with `{data,expectedRevision,mutationId}`; `GET /admin/employees`, `/admin/employees/{uid}`, `GET/POST /admin/invites`, `DELETE /admin/invites/{id}`, `POST /admin/users/{uid}/reset`. Success response is typed JSON, failures `{error:code}`, 401 unauthenticated, 403 forbidden, 409 stale revision, 422 invalid input, 429 limited. Never accept arbitrary uid/role in own write or registration body.

- [ ] Add tests `test_staff_cannot_list_or_read_other`, `test_admin_read_only_others_own_write_ok`, `test_unknown_fields_cannot_escalate`, `test_invite_list_never_discloses_code`, `test_stale_revision_rejected`, `test_lost_response_retry_idempotent`, `test_same_mutation_id_different_body_rejected`, `test_invalid_oversize_and_nonfinite_payload`, `test_wrong_origin_and_method`, `test_invalid_token_denies_before_data_query`. Assert direct requests with a staff token to admin endpoints 403; admin token cannot write other UID through any route; 2 writes with same expected revision only one wins, retry same body/mutation returns original revision; no data fetched after invalid auth. Include two-device YDB transaction race in integration suite.
- [ ] Run `python -m unittest discover -s backend/tests -p 'test_worklog.py' -v` and `-p 'test_http.py'` separately, expect red.
- [ ] Implement own record revision check plus idempotency record in same transaction; 512 KiB max payload; validate required settings, ISO calendar date keys and version 1, money/hours finite bounded nonnegative where applicable (compare current default settings and day shape), text sizes, boolean fields; reject unknown top-level fields and prohibit unexpected storage paths. Server sets timestamps and revision. Collect minimal audit events without credentials or shift contents. Bound employee list pagination while preserving client adapter. Parse actual gateway event and trusted source IP, never caller-supplied IP; CORS only actual `https://localhost`/`http://localhost` Capacitor origins if necessary; `OPTIONS` preflight; no-store. Deployment template private function ID supplied at deploy, gateway invoker SA scoped to new function, application SA with access to test DB only. No direct public function or public backup endpoint. Rate-limit unauthenticated calls before expensive work; fail safely if DB unavailable. Gateway spec explicitly lists routes; no open arbitrary proxy.
- [ ] Run all backend tests and dedicated real DB suite before deployment; commit.

### Task 3: Client transport, offline sync and existing UI

**Files:** `api.js`, `sync.js`, `test/api.test.cjs`, `test/sync.test.cjs`, `index.html`, `account.js`, `test/account.test.cjs`, `test/account-integration.test.cjs`.

**Interfaces:** `WorklogApi.create({baseUrl,fetch,tokenStore})` returns `login`, `register`, `renew`, `logout`, `reset`, `getWorklog`, `putWorklog`, `employees`, `employee`, `createInvite`, `listInvites`, `revokeInvite`, `issueReset` matching Task 2 HTTP contracts; `tokenStore` memory-only until independently reviewed native secure storage exists. `WorklogSync.create({uid,storage,api,onState})` returns `load()`, `edit(data)`, `flush()`, `refresh()`, `resolveConflict(choice)` where choice is `'server'` (retain local draft for export) or `'retry-local'` (after explicit user confirmation use current server revision), `close()`. Store keys `worklog.yandex.test.v1:<uid>`, companion pending/conflict records; state `{data,revision,pending,conflict,error}`. Use per-account generation guard; old sessions cannot commit callbacks to a new account. No passwords/tokens in web localStorage. Existing `employeeRows` continues consuming `users` mapping.

- [ ] Add red tests `test_login_register_invite_payload`, `test_token_never_in_localstorage`, `test_401_renew_once`, `test_logout_clears_token_even_if_offline`, `test_pending_retries_same_mutation`, `test_two_devices_conflict_preserves_draft`, `test_empty_server_no_cross_account_upload`, `test_switch_ignores_old_inflight`, `test_login_without_invite_allowed_only_existing`, `test_admin_own_edit_and_employee_readonly`, `test_invite_management_hidden_for_staff`, `test_no_firebase_scripts_or_calls`, `test_export_import_keeps_v1`. Use `node:test` mocks, assert one retry on 401, same mutation ID on uncertain write, no account A data in B cache, conflict local draft retained across rebind, old response discarded, original personal/employee calculation tests preserved or adapted for new transport.
- [ ] Run `npm test`; expect red from missing transport/sync modules or Firebase-specific assertions until updated.
- [ ] Implement transport and sync as external UMD modules (matching `account.js`), request timeout and bounded backoff, serialized writes/coalescing before send, immutable in-flight payload; persist unsent draft scoped by uid and expected revision before network, retry on reconnect/foreground and poll while logged in, no last-write-wins. If no secure token plugin chosen, login again after application restart; offline editing only for an already authenticated in-memory session. Guard every asynchronous render and cache write by session ID. UI preserves bottom nav and existing pay/day/export/import functions. Login form adds invitation only for registration; reset redemption via private code; admin employees area adds copy/create/list/revoke invitation and issue reset button for verified owner interaction. Escape dynamic text using textContent; on 403 close admin view. Show sync/pending/conflict status and explicit recovery without silently discarding data. Remove Firebase scripts and `initFirebase` invocation, replace Firebase reference calls; adapt `userScope` to UUID and separate namespace. Never log personal data or keys.
- [ ] Run `npm test`; require complete suite green; exercise phone UI in test client and commit.

### Task 4: Private backups and isolated operational setup

**Files:** `backend/backup.py`, `backend/tests/test_backup.py`, `cloud/README.md`, `cloud/gateway.yaml`, `backend/requirements.txt`.

**Interfaces:** `export_snapshot(store, object_writer, clock) -> Manifest`, `restore_snapshot(store, object_reader, manifest, confirm_isolated=False) -> Result`; scheduled backup handler accepts only timer invocation via cloud IAM. Manifest includes schema version, UTC timestamp, checksums and counts, object path under new `yandex-test/` prefix; restore requires explicit isolated target. Snapshot excludes session and reset token records, includes invite IDs/states but on restore invalidate every unused invite to avoid replay from old snapshots; invalidate all sessions and reset codes. No plaintext secrets in snapshot/logs.

- [ ] Tests `test_snapshot_does_not_export_sessions`, `test_restore_requires_isolated_target`, `test_restore_never_reopens_consumed_invites`, `test_corrupt_snapshot_rejected`, `test_restore_roles_and_worklogs_preserved`, `test_backup_failure_reported`, `test_retention_config_30_days`. Assert restored invite is invalid even if snapshot was taken before use, restored users and worklogs match, checksum mismatch rejected before any write; backup cannot be exposed through application gateway.
- [ ] Run `python -m unittest discover -s backend/tests -p 'test_backup.py' -v`; expect red.
- [ ] Implement consistent transactional snapshot for pilot dataset with size limits and pagination/spill where needed; private Object Storage writes via least-privilege backup identity, bucket encryption at rest, HTTPS, immutable date/UUID key, manifest written last. Restore verifies checksums/schema/counts and runs only against explicitly isolated empty test DB. Document daily timer, 30-day lifecycle, monitoring and cost alerts, separate app/backup identities, setup/teardown and smoke test instructions. No billing or cloud configuration write until owner approves resource names, region, projected cost/limits and gateway exposure. Confirm existing `worklog-api` is unchanged, no public bucket ACL. Use official Yandex docs linked in spec to validate actual syntax and SDK.
- [ ] Run backend suite and simulated restore; commit. Hosted restoration rehearsal is required before using real data.

### Task 5: Isolated signed build, deployed smoke test and phone handoff

**Files:** `capacitor.config.json`, `.github/workflows/build-apk.yml`, `README.md`, `test/account-integration.test.cjs`, separate `cloud/README.md` operational checklist.

- [ ] Add tests that config app ID is `com.worklog.app.yandex.test`, label `Worklog Yandex Test`, and workflow packages `api.js`, `sync.js`, `account.js`, `index.html`; no Firebase references, branch trigger scoped to `worklog-yandex-test`, distinct artifact `WorklogYandexTest-release`, no cloud credentials in web assets. Run `npm test` red before changes.
- [ ] Update config and CI branch workflow: Python 3.12 unit suite with pinned dependencies before Node suite, public gateway URL via non-secret repository variable or build argument; explicit HTTPS validation, fail release packaging when unset/invalid, no test endpoint accidentally selected. Copy the three JS modules and HTML into `www`, existing signing secrets remain untouched; keep separate version code/artifact. Update README with isolated install, test login instructions, operator procedure, manual export/import and no marketplace preparation.
- [ ] Run local tests `npm test` and `python -m unittest discover -s backend/tests -v`; report actual pass/skip. Commit only to Yandex branch; verify GitHub branch diff and old stable SHA.
- [ ] **Deployment gate:** obtain owner go-ahead for actual resources/budget; create isolated Serverless YDB, apply schema, assign separate scoped SAs, deploy private functions and gateway after negative auth tests, run YDB integration against test DB, bootstrap owner via privately delivered token, two synthetic employee accounts, test direct denied requests and concurrent invite reuse; configure private daily backup and perform restore dry-run. No real account/data transfer. Set verified public gateway URL for APK build after endpoint works.
- [ ] Trigger GitHub Actions and verify successful signed artifact, package ID, signing and version; give owner a downloadable APK (not just a CI zip link), which installs beside #28. Device acceptance: admin own shift + employee view, invitation consume/reject replay, staff own shift only, logout/session behavior, airplane-mode editing while session active, conflicting writes from second device, manual export/import, dark/light theme, old app still working. Document blockers exactly; stop distribution of real data until acceptance/privacy readiness. Commit final test notes.

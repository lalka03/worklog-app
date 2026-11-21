# Remembered sessions implementation plan

Spec: `docs/superpowers/specs/2026-11-21-remember-me-design.md` (approved).

Work on the existing isolated pilot branch. Never alter account/worklog data, database schema, backup, app ID, or release signing. Deployment is a separate approval gate.

## Task 1 — Server policy
- Extend `backend/tests/test_auth.py` and `backend/tests/test_http.py` with fixed 30-day expiry, 7-day default, rotation and strict flag tests. Run backend unittest discovery; expected initial failure on missing feature.
- In `backend/service.py` accept `remember: bool = False`, validate strict bool, select fixed TTL on creation only. In `backend/index.py` allow only optional `remember` on login. Run full backend tests, expected green. Commit.

## Task 2 — Client session lifecycle
- Add `test/api.test.cjs` tests for remembered login, restore and rotate, invalid/expired/temporary failure, unchecked and unsupported storage, and delayed network/storage logout races. Run `node --test test/api.test.cjs` (RED).
- In `api.js` accept optional async `rememberStore` (`get`, `set(refreshToken)`, `clear`), expose `restore()`, serialize storage operations and guard generation, preserve ordinary login payload. Android storage errors fail closed. Run `npm test` (GREEN). Commit.

## Task 3 — Native bridge and UI
- Add tests for native source staging and opt-in UI/startup behavior; run `npm test` (RED).
- Create Java Capacitor plugin registered before activity creation. AES/GCM Keystore key, private no-backup atomic encrypted file, no plaintext secrets. Stage plugin sources after cap add in workflow. Wire optional unchecked login checkbox and restore/retry/forget panel in index.html, no browser fallback. Run `npm test` (GREEN). Commit.

## Task 4 — Review, integration and delivery
- Review whole change for races, failure handling, expiry, secure storage and regression risks. Resolve important findings with tests. Run full test suites, check diff and native staging. Verify signed Android build with existing identity via manual CI release only after approved backend deployment. Preserve existing pilot. If any environment or permission blocks testing or deployment, report precise blocker and do not claim completion.

Review focus: reset/revocation, cross-account races, offline startup, failed secure-store clear/write, Android backup exclusion, compatibility and untouched worklog records.

# Worklog Yandex: remember me

## Intent

The owner wants to reopen the installed Worklog Yandex Test Android app without re-entering email and password every time. A checked, optional «Запомнить меня» checkbox grants a maximum 30-day remembered session; ordinary sign-in keeps its existing policy. The feature applies equally to administrators and employees. Existing worklogs, offline drafts, account isolation, and backup configuration must be preserved.

## Approaches

- Retain the current seven-day server session and persist it securely: smaller server change, but weekly reauthentication. The owner selected 30 days instead.
- Issue an opt-in, fixed maximum 30-day session and protect only the rotating refresh credential in Android Keystore-backed encrypted storage. Selected; no saved password, no database schema change, no indefinite session.
- Save credentials in plaintext browser storage, or keep sessions indefinitely: rejected due to credential exposure and lack of bounded expiry.

## Behavior and safety constraints

- Checkbox on login screen, unchecked by default. Only explicitly checked successful login creates a remembered session. No new user prompt for existing sessions. Unchecked login and existing APK clients retain the seven-day server policy and memory-only client behavior.
- Login API accepts an optional strictly boolean remember flag, defaults to false. Existing registration/reset clients are unchanged. Initial remembered refresh expiration is now + 30 days; renewing rotates credentials but never extends that fixed expiry. Access-token lifetime stays 15 minutes. Existing session revocation, role checks, reset and disabled-account behavior stay enforced.
- Android-only persistent storage: a narrowly scoped Capacitor native bridge using Android Keystore AES/GCM and app-private encrypted storage (excluded from Android backups). Store refresh credential only, never password or access credential. No browser localStorage/sessionStorage fallback for secrets. If storage is unavailable, ordinary login remains available; do not claim the session was saved.
- At launch, restore from the protected refresh credential and verify it on the server before binding the account or showing private worklogs. Rotate and save the new refresh credential before exposing a restored successful session. Transient network failure presents retry and sign-out options, without discarding the saved credential. Invalid/expired/revoked sessions clear it and show login. Logout clears the local remembered credential and existing in-memory account state; server revocation remains best-effort when offline. Cancellation/generation checks must prevent delayed renewal from recreating a logged-out session or opening another account.
- No changes to the user’s account records, worklogs, backup schedule, pilot API gateway public scope, app ID, or signing identity. Preserve compatibility with existing APK while deploying backend first, after explicit deployment approval. Browser-only persistence is outside this Android APK change (no insecure token fallback).

## Verification

Backend tests cover default and opt-in expiry, strict flag validation, rotation without extending expiry, logout/reset/revocation, and old clients. Client tests cover opt-in only, restoration across instances, storage unavailable, offline retry, expiry, rotation persistence and logout/account-change races. Verify the native bridge is installed in signed Android build and encrypted store is unavailable to other apps; test on device (close/relaunch and reboot, sign out, account isolation). Check existing test suites and APK identity/version before offering an update. No claim of deployed or device-tested success until verified.

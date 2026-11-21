# Offline remembered sessions

## Intent and scope

Worklog Yandex Test #32 requires a server renewal before showing personal data on cold start. In airplane mode this blocks the remembered user. Provide personal shift viewing, editing, totals and local drafts during a remembered session without connectivity. Automatically resume the existing conflict-aware sync after server verification. No passwords persisted, no public-access change, no new cloud resources, no changes to Firebase or the existing worklog schema.

## Approaches

- Online-only verification (current behavior): strongest freshness of revocation but prevents the requested offline launch.
- Protected, bounded offline identity (selected): persist the server-verified account identity and absolute refresh expiry alongside the refresh credential in the existing Android Keystore-backed, no-backup atomic store. Open only that account's local worklog when the server cannot be reached; validate upon reconnection.
- Unbounded local login or persisting passwords: rejected; would compromise account isolation and the agreed 30-day limit.

## Behavior and boundaries

- The existing optional 30-day remembered login enables offline access after one successful online login or renewal with the new build. Existing token-only stores require one online renewal to migrate; no password re-entry if renewal is valid. The backend adds absolute refresh expiry to auth results without breaking old clients; rotation never extends that expiry.
- A usable offline grant has a valid UID, email and absolute server-provided expiry; it lives atomically with the encrypted rotating token. Corrupt, expired, missing or clock-rollback-indicating grants do not open private data. Exiting removes the grant; ordinary non-remembered login stays unchanged.
- Offline opens only the previously verified user's scoped, validated local cache (never another user's). Show a clear offline/pending-sync indicator. Permit personal shifts and totals; preserve drafts and conflict handling. No employee list, invites, password reset issuance or other administrator requests or cached employee data while offline. While offline, expiration is checked on foreground, periodic expiry check and personal writes. Offline access cannot know about a remote revocation before reconnecting; it is bounded by the original expiry and phone's time protections.
- On online/foreground/retry, revalidate the remembered session with the server before any protected request or upload; enforce the same UID and update role from the verified response. Network failure preserves the draft and retries; a rejected/revoked session locks private data and removes the grant, retaining the scoped draft for safe recovery on a subsequent valid login. Late responses must not reopen a logged-out or switched account. Conflicting server revisions retain the existing explicit reconciliation flow.
- Verify server expiry and compatibility, native storage migration and atomicity, offline cold start and edits, reconnection, expired and revoked session, account separation, admin lockout and logout/renewal races. Run the existing test suites; build and check signed APK identity/version; verify on the user's phone before declaring offline device acceptance.

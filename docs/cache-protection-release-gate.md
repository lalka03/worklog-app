# Worklog: cache protection candidate — controlled future update gate

Status: **candidate only**, created 2026-11-23. No APK was deployed, no active
Android app was updated, and no Yandex resource was touched.

## Exactly what changes

Candidate branch: `worklog-cache-protection-rc-20261123`, based on the
untouched installed #36 source commit
`d73eee4d55076362b6d914a12de9ea875e0cba32`.

Only runtime changes:
- `sync.js`: structurally validate historical local cache records including
  queued mutations and unresolved conflicts; quarantine malformed and
  unreadable caches without overwriting/clearing the bytes; offer
  non-destructive `retryCache()` after the underlying problem is resolved.
- `index.html`: show a specific warning, expose retry reading, suppress
  misleading empty JSON backup export when the local cache is inaccessible.

Unchanged code blobs from the #36 source:
- `api.js` Git blob SHA-1
  `9e8673f1614d2f1ba9d323f3b1aef06a0519ecf0`;
- `account.js` Git blob SHA-1
  `10ff04c87a3e482ddc35cac88673d3bfe527de6a`.

The release candidate is **not** the standalone Offline Lab APK. Its production
package identifier remains `com.worklog.app.yandex.test` solely to enable a
potential future in-place upgrade **after owner approval**. It must never be
installed during candidate testing without completing the gates below.

## Evidence and limitations

The separately packaged offline laboratory
`com.worklog.app.yandex.cacheqa` was accepted on the owner's Android
phone on 2026-11-23: **4/4 synthetic checks** (damaged JSON, read error,
malformed mutation queue, write failure), with no account, network, or
production storage access.

Synthetic JavaScript tests additionally exercise older persisted v1 snapshots,
offline pending changes, replayed mutation receipts and unresolved conflicts.
The release-candidate GitHub Action
`.github/workflows/cache-protection-candidate.yml` runs only unit/regression
tests. It explicitly blocks accidental modification of production auth code,
app identity, or native bridge. There is no automatic APK release, gateway,
cloud deploy, or database migration.

These results do **not** prove that physical Android flash corruption,
full-device backup restoration, or an actual old #36 installation upgraded
in-place will work. Six separate hosted-YDB integration checks remain
unexecuted until approval for an isolated database and verification of cost.

## Gate before any future production-signature in-place APK

1. Obtain explicit owner permission for a specific prospective update
   version/build; keep current installed **#36**, `main`, Firebase #28,
   stable #26 and live YDB intact until then.
2. Export a **fresh dated JSON** from the actual installed #36; confirm its
   size, nonempty shift count and integrity on a separate destination.
   Do not paste personal shifts into GitHub or CI.
3. Verify the new candidate produces `com.worklog.app.yandex.test` with a
   strictly higher versionCode **than 36**, same trusted signing certificate,
   correct HTTPS origin, and exact approved web assets. Keep a trusted copy
   of #36 APK. A lower-version APK cannot ordinarily be installed over the
   newer version without invasive steps; never uninstall to force rollback.
4. First test a compatible app upgrade with **synthetic records**, retained
   login, offline restart, manual export, reconnect and conflict, using a
   disposable Android environment. This standalone Offline Lab alone
   does not establish upgrade compatibility.
5. Only then request owner's separate consent to install over #36 (never
   delete/clear it). Validate that the real admin session stays available
   and real shift totals/revisions match the pre-upgrade snapshot, without
   modifying real shifts as a test. If any result differs, stop, preserve
   phone data and use a safe recovery plan.
6. Keep the cloud restore drill blocked until real Yandex Billing usage,
   remaining shared free allocations, numerical maximum cost, exact DB ID
   and explicit resource authorization are confirmed.

Do not interpret successful synthetic tests as consent to publish or install.

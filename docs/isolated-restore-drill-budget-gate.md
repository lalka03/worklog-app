# Isolated YDB restore drill — cost and safety gate (prepared 2026-11-23)

## Status
**Preparation only. Do not create any database or restore any live backup before the owner reviews the billing state and separately approves the exact operations and spending limit.** No production branch changes.

## Pricing evidence (Yandex Cloud docs, consulted 2026-11-23)
- Serverless YDB has a monthly billing-account-level free tier of 1,000,000 Request Units (RU) and 1 GiB of stored data. This free amount is **shared** across attached organizations and clouds; it is not per database. https://yandex.cloud/ru/docs/billing/concepts/serverless-free-tier
- Charges beyond the free tier depend on RU consumption, hourly data storage and (where applicable) restore/backup/egress operations. See current tariff for actual payer contract, currency and region. https://yandex.cloud/ru/docs/ydb/pricing/serverless
- Default serverless cloud quota is 10 databases, 1,000 RU/s and 300 GiB total storage, but real available quota must be queried before provisioning. https://yandex.cloud/ru/docs/ydb/concepts/limits
- Cloud Billing budgets alert, **do not stop service usage at the threshold**. https://yandex.cloud/ru/docs/getting-started/individuals/payments

## Proposed one-time drill limits
- One **new** YDB Serverless OLTP database, not Dedicated.
- Distinct name e.g. `worklog-restore-qa-20261123` in the approved pilot folder. Check that it does not already exist first.
- Limit storage to **1 GiB** initially and limit serverless RU throughput to **10 RU/s** where supported; provisioned capacity **0 RU/s** (no fixed hourly RU capacity). Verify actual effective parameters with a read-only get before schema creation.
- No API Gateway, public application binding, trigger, scheduled backup, new Object Storage bucket, managed VM or new persistent KMS key for the restore target.
- Use existing private backup artifacts in **read-only** mode only after separate approval of the specific snapshot and data exposure risks.
- Use a temporary restore identity allowed to write **only** the new DB, not the source. Never print credentials, account email addresses, password hashes, snapshots, or tokens.
- Verify existing backup manifest integrity, metadata and row counts locally before any restore.
- Reproduce schema in new DB; ensure empty target and distinct database path. The Python `restore_snapshot` code verifies manifest checksum, snapshot structure, source!=target and empty destination.
- Start with synthetic backup rehearsal. Restore production-derived snapshot only on explicit owner approval, with private access; restore database is never connected to live Worklog.
- Stop if current month YDB RU usage or storage is close to the shared free threshold, payer or cost terms are uncertain, quotas insufficient, IAM unexpected, or any permission would grant write on the source.
- Take measured spending before/after, label the resource for disposal, and **delete only the exact temporary DB** at the end after checking its ID. Retain existing source database and backups untouched. One small test should finish in a supervised session, not left for background work.

## Decision gate before creation
1. Owner checks billing-account YDB month-to-date RU and storage usage, current incurred charges and payer currency, and active discounts/credits in Yandex Cloud Billing.
2. Operator checks currently available serverless DB quota and counts, chosen test folder, source/backup IDs and permissions via read-only calls.
3. Agree a **numeric maximum additional cost**, including allowance for incidental charges. Budget alert alone is not a hard stop. If exact cap cannot be ensured, do not create.
4. Obtain explicit approval to create exactly one resource with verified low-cost parameters.
5. Record exact creation resource ID, test evidence, costs, cleanup and rollback in the private Worklog checkpoint.

Notes: a successful in-memory backup restore test is already covered in `test_reliability_qa.py`; no YDB hosted restore acceptance has yet been performed.


## Post-provisioning identity and cost-parameter check (read-only)

After **separate approval** and manual creation of exactly one temporary restore database,
use `scripts/operator-restore-target-config-check.py --target-id <new-db-ID>`
from an authorized Cloud Shell. It does **not** create any database or restore any data.

The script rejects missing/ambiguous metadata and verifies that the target is distinct
from the existing source DB, is named `worklog-restore-qa-20261123`, belongs
to the pilot folder, is RUNNING and Serverless, and has the exact target endpoint
path. It reads the parent cloud ID from the verified folder, then checks the
endpoint path as `/ru-central1/<cloud-id>/<new-db-id>`. The database metadata
must independently identify the approved folder. It demands `storage_size_limit` in (0, 1 GiB], `enable_throttling_rcu_limit=true`,
`throttling_rcu_limit` in [1, 10] RU/s and `provisioned_rcu_limit=0`.
**Do not confuse the two RU fields.** A throttling value without the enable flag
does not impose a rate cap. Provisioned RU creates regular charges even without
requests. 10 RU/s is an initial cap only and may be too restrictive to complete a
hosted restore quickly; verify whether the actual restore can run within this cap
before approving the resource. See Yandex Cloud
[Serverless database fields](https://yandex.cloud/ru/docs/ydb/api-ref/Database/get)
and [CLI parameter definitions](https://yandex.cloud/ru/docs/ydb/cli-ref/database/update).

An accepted read-only result is `TARGET_LIMITS_VERIFIED_BILLING_NOT_VERIFIED`
plus `NO_RESTORE_PERFORMED`. These markers **do not** certify an actual billing
cap, available free quota, least-privilege IAM, absence of existing app bindings,
or that any restore has been performed. Do not start a restore until those matters
are separately confirmed. All errors stop; never "fix" cloud settings automatically.

**Implementation status:** tests for this preflight and its refusal paths are in
`backend/tests/test_restore_target_config.py`. It has not been run against the
owner's cloud and must not be interpreted as a deployed change.

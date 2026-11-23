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

"""Disable only the synthetic Offline QA employee created on 2026-11-23.

Operator script: requires already-authenticated Yandex Cloud Shell.
Does not log credentials and never accesses other employee or admin records for writing.
"""
import json
import subprocess
import urllib.parse
from contextlib import closing

import ydb
from backend.store import YdbStore
from backend.service import disable_account

TARGET = 'worklog.offline.qa.20261123@example.com'
FOLDER = 'b1gbctisrf70nalca0ve'
DATABASE_ID = 'etntoapt41gu9i5u5blj'
EARLIEST = 1795392000

folder = subprocess.check_output(['yc', 'config', 'get', 'folder-id'], text=True).strip()
if folder != FOLDER:
    raise SystemExit('WRONG_FOLDER_STOP')

info = json.loads(subprocess.check_output([
    'yc', 'ydb', 'database', 'get', '--id', DATABASE_ID, '--format', 'json'
], text=True))
if info.get('id') != DATABASE_ID or info.get('name') != 'worklog-yandex-test-db':
    raise SystemExit('WRONG_DATABASE_STOP')
u = urllib.parse.urlsplit(info['endpoint'])
if u.scheme not in ('grpcs', 'grpc') or not u.netloc:
    raise SystemExit('INVALID_ENDPOINT_STOP')
params = urllib.parse.parse_qs(u.query)
if len(params.get('database', [])) != 1:
    raise SystemExit('INVALID_DATABASE_PATH_STOP')
credential = subprocess.check_output(['yc', 'iam', 'create-token'], text=True).strip()
with closing(YdbStore.connect(
    u.scheme + '://' + u.netloc,
    params['database'][0],
    ydb.AccessTokenCredentials(credential),
)) as store:
    account = store.run_read(lambda tx: tx.get_account_by_email(TARGET))
    if not (account and account.email == TARGET and account.role == 'employee'
            and account.enabled is True and account.created_at >= EARLIEST):
        raise SystemExit('QA_ACCOUNT_GUARD_STOP')
    generation = account.session_generation
    disable_account(store, account.uid)
    updated = store.run_read(lambda tx: tx.get_account(account.uid))
    if not (updated and updated.uid == account.uid and updated.email == TARGET
            and updated.role == 'employee' and updated.enabled is False
            and updated.session_generation == generation + 1):
        raise SystemExit('QA_DISABLE_VERIFY_FAILED')
print('QA_OFFLINE_DISABLED_OK')

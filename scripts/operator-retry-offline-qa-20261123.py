"""Targeted 2026-11-23 Offline QA employee disable with safe outcome reporting.

Runs against the explicitly identified Yandex pilot folder and YDB only.
Does not touch admin accounts, other employees, worklog records, or backups.
"""
import json
import subprocess
import urllib.parse
from contextlib import closing

import ydb
from backend.service import disable_account
from backend.store import StoreUnavailable, YdbStore

TARGET = 'worklog.offline.qa.20261123@example.com'
FOLDER_ID = 'b1gbctisrf70nalca0ve'
DATABASE_ID = 'etntoapt41gu9i5u5blj'
MIN_CREATED = 1795392000

folder = subprocess.check_output(['yc', 'config', 'get', 'folder-id'], text=True).strip()
if folder != FOLDER_ID:
    raise SystemExit('WRONG_FOLDER_STOP')
info = json.loads(subprocess.check_output([
    'yc', 'ydb', 'database', 'get', '--id', DATABASE_ID, '--format', 'json'
], text=True))
if info.get('id') != DATABASE_ID or info.get('name') != 'worklog-yandex-test-db':
    raise SystemExit('WRONG_DATABASE_STOP')
url = urllib.parse.urlsplit(info['endpoint'])
paths = urllib.parse.parse_qs(url.query).get('database', [])
if url.scheme != 'grpcs' or not url.netloc or len(paths) != 1:
    raise SystemExit('WRONG_ENDPOINT_STOP')
credential = subprocess.check_output(['yc', 'iam', 'create-token'], text=True).strip()
with closing(YdbStore.connect(
    url.scheme + '://' + url.netloc, paths[0], ydb.AccessTokenCredentials(credential)
)) as store:
    initial = store.run_read(lambda tx: tx.get_account_by_email(TARGET))
    if not (initial and initial.email == TARGET and initial.role == 'employee'
            and initial.created_at >= MIN_CREATED):
        raise SystemExit('QA_GUARD_STOP')
    if initial.enabled:
        try:
            disable_account(store, initial.uid)
        except StoreUnavailable as err:
            cause = err.__cause__
            print('QA_DISABLE_ERROR_' + (type(cause).__name__ if cause else type(err).__name__))
    latest = store.run_read(lambda tx: tx.get_account(initial.uid))
    if not (latest and latest.uid == initial.uid and latest.email == TARGET
            and latest.role == 'employee' and latest.created_at >= MIN_CREATED):
        raise SystemExit('QA_POSTCHECK_STOP')
    if latest.enabled is False and latest.session_generation > initial.session_generation:
        print('QA_OFFLINE_DISABLED_OK')
    elif latest.enabled is False and initial.enabled is False:
        print('QA_ALREADY_DISABLED_OK')
    elif latest.enabled is True:
        print('QA_ACCOUNT_STILL_ACTIVE')
        raise SystemExit(1)
    else:
        raise SystemExit('QA_STATE_INCONSISTENT_STOP')

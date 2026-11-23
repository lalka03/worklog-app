"""Read-only verification of the one Worklog Offline QA employee after uncertain YDB transaction.
Does not change or create any account, session, worklog, or cloud resource.
"""
import json
import subprocess
import urllib.parse
from contextlib import closing
import ydb
from backend.store import YdbStore

TARGET='worklog.offline.qa.20261123@example.com'
FOLDER='b1gbctisrf70nalca0ve'
DB_ID='etntoapt41gu9i5u5blj'
if subprocess.check_output(['yc','config','get','folder-id'], text=True).strip()!=FOLDER:
    raise SystemExit('WRONG_FOLDER_STOP')
info=json.loads(subprocess.check_output(['yc','ydb','database','get','--id',DB_ID,'--format','json'],text=True))
if info.get('id')!=DB_ID or info.get('name')!='worklog-yandex-test-db':
    raise SystemExit('WRONG_DATABASE_STOP')
u=urllib.parse.urlsplit(info['endpoint'])
ds=urllib.parse.parse_qs(u.query).get('database',[])
if u.scheme!='grpcs' or not u.netloc or len(ds)!=1:
    raise SystemExit('BAD_DB_ENDPOINT_STOP')
t=subprocess.check_output(['yc','iam','create-token'],text=True).strip()
try:
    with closing(YdbStore.connect(u.scheme+'://'+u.netloc,ds[0],ydb.AccessTokenCredentials(t))) as store:
        a=store.run_read(lambda tx: tx.get_account_by_email(TARGET))
except Exception as e:
    print('QA_READ_FAILED_'+type(e).__name__)
    raise SystemExit(1) from None
if not a:
    print('QA_ACCOUNT_NOT_FOUND_STOP')
elif a.email!=TARGET or a.role!='employee' or a.created_at <1795392000:
    print('QA_ACCOUNT_GUARD_STOP')
elif a.enabled:
    print('QA_ACCOUNT_STILL_ACTIVE')
else:
    print('QA_ACCOUNT_DISABLED_CONFIRMED')

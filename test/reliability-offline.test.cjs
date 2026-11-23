const test = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../sync.js');

// Pure synthetic snapshots; no live API, YDB, or personal shift data.
const uid = '00000000-0000-4000-8000-000000000091';
const key = 'worklog.yandex.test.v1:' + uid;
function snapshot(hours) {
  return {
    version: 1,
    settings: {
      anchor: '2026-11-23', th1: 3, th2: 13, coef: 1.5,
      p1: 3, p2: 3, p3: 3, rates: {'1': 280, '2': 322, '3': 350},
    },
    days: {
      '2026-11-23': {
        date: '2026-11-23', main: {hours: String(hours), route: 1},
      },
    },
  };
}
function disk() {
  const records = new Map();
  return {
    records,
    getItem: k => records.get(k) ?? null,
    setItem: (k, value) => records.set(k, value),
  };
}
function setup() {
  const storage = disk();
  const original = snapshot(2);
  const changedOnAnotherDevice = snapshot(4);
  let remote = {data: original, revision: 1};
  let online = true;
  const writes = [];
  const api = {
    getWorklog: async () => {
      if (!online) throw new TypeError('network unavailable');
      return remote;
    },
    putWorklog: async write => {
      if (!online) throw new TypeError('network unavailable');
      writes.push(write);
      if (write.expectedRevision !== remote.revision) {
        throw Object.assign(new Error('stale revision'), {
          code: 'stale_revision', status: 409,
        });
      }
      remote = {data: write.data, revision: remote.revision + 1};
      return {revision: remote.revision, updatedAt: '2026-11-23T12:00:00Z'};
    },
  };
  const client = () => create({uid, storage, api, canSend: () => online});
  return {
    storage, writes, client, original, changedOnAnotherDevice,
    offline: () => { online = false; },
    online: () => { online = true; },
    changeServer: () => { remote = {data: changedOnAnotherDevice, revision: 2}; },
    remote: () => remote,
  };
}

test('offline draft survives cold restart and 409; explicit local retry uses newest revision', async () => {
  const system = setup();
  const phone = system.client();
  await phone.refresh();
  assert.equal(phone.load().revision, 1);
  system.offline();
  assert.equal(phone.edit(snapshot(3)), true);
  assert.ok(system.storage.records.has(key));
  phone.close();

  // Another device saves while this phone is disconnected.
  system.changeServer();
  system.online();
  const restarted = system.client();
  assert.deepEqual(restarted.load().data, snapshot(3));
  await restarted.flush();
  const conflict = restarted.load().conflict;
  assert.equal(conflict.reason, 'stale_revision');
  assert.deepEqual(conflict.local, snapshot(3));
  assert.deepEqual(conflict.server, snapshot(4));
  assert.equal(system.remote().revision, 2);
  await restarted.resolveConflict('retry-local');
  assert.deepEqual(system.writes.map(write => write.expectedRevision), [1, 2]);
  assert.notEqual(system.writes[0].mutationId, system.writes[1].mutationId);
  assert.deepEqual(system.remote(), {data: snapshot(3), revision: 3});
  assert.equal(restarted.load().conflict, null);
  assert.equal(restarted.load().pending, null);
});

test('after offline conflict the server choice does not silently overwrite another device', async () => {
  const system = setup();
  const phone = system.client();
  await phone.refresh();
  system.offline();
  assert.equal(phone.edit(snapshot(3)), true);
  phone.close();
  system.changeServer();
  system.online();

  const restarted = system.client();
  await restarted.flush();
  assert.deepEqual(restarted.load().conflict.local, snapshot(3));
  await restarted.resolveConflict('server');
  assert.deepEqual(restarted.load().data, snapshot(4));
  assert.deepEqual(system.remote(), {data: snapshot(4), revision: 2});
  assert.equal(system.writes.length, 1);
  assert.equal(restarted.load().conflict.resolved, true);
  assert.deepEqual(restarted.load().conflict.local, snapshot(3));
  await restarted.flush();
  assert.equal(system.writes.length, 1);
});

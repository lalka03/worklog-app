'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../sync.js');

const uid = '00000000-0000-4000-8000-000000000091';
const other = '00000000-0000-4000-8000-000000000092';
const cacheKey = id => 'worklog.yandex.test.v1:' + id;
const date = '2026-11-23';
function snapshot(hours) {
  return {
    version: 1,
    settings: {
      anchor: date, p1: 3, p2: 3, p3: 3, th1: 3, th2: 13, coef: 1.5,
      rates: {'1': 280, '2': 322, '3': 350}
    },
    days: {[date]: {date, main: {hours: String(hours), route: 1}}}
  };
}
function storage() {
  const records = new Map();
  let fail = false;
  return {
    records,
    getItem(k) {
      if (fail) throw Error('read failed');
      return records.get(k) ?? null;
    },
    setItem(k, data) {records.set(k, data);},
    failReads: value => {fail = value;}
  };
}
function api() {
  const sent = [];
  const remote = {data: null, revision: 0};
  return {
    sent,
    remote,
    getWorklog: async () => ({...remote}),
    putWorklog: async payload => {
      sent.push(payload);
      assert.equal(payload.expectedRevision, remote.revision);
      remote.data = payload.data;
      remote.revision++;
      return {revision: remote.revision, updatedAt: '2026-11-23T12:00:00Z'};
    }
  };
}
const bind = (disk, server, id=uid) => create({uid: id, storage: disk, api: server});
const persisted = (data, revision, pending=null, conflict=null) =>
  JSON.stringify({data, revision, pending, conflict});

test('broken JSON is quarantined: no overwrite, edit, read or upload, even when online', async () => {
  const disk = storage(), server = api();
  const broken = '{"data":'; // May contain an otherwise recoverable unsent shift.
  disk.records.set(cacheKey(uid), broken);
  const sync = bind(disk, server);
  assert.equal(sync.load().error, 'cache_corrupt');
  assert.equal(sync.load().data, null);
  assert.equal(sync.edit(snapshot(3)), false);
  await sync.refresh();
  await sync.flush();
  assert.equal(server.sent.length, 0);
  assert.equal(disk.records.get(cacheKey(uid)), broken);
  assert.equal(sync.retryCache(), false);
  assert.equal(disk.records.get(cacheKey(uid)), broken);
  sync.close();
  const reopened = bind(disk, server);
  assert.equal(reopened.load().error, 'cache_corrupt');
  assert.equal(disk.records.get(cacheKey(uid)), broken);
});

test('empty-string cache is not silently accepted as a new empty account', async () => {
  const disk = storage(), server = api();
  disk.records.set(cacheKey(uid), '');
  const sync = bind(disk, server);
  assert.equal(sync.load().error, 'cache_corrupt');
  await sync.refresh();
  assert.equal(sync.edit(snapshot(2)), false);
  assert.equal(disk.records.get(cacheKey(uid)), '');
});

test('a malformed pending write is quarantined before any network operation', async () => {
  const disk = storage(), server = api();
  const bad = persisted(snapshot(3), 0, {
    data: snapshot(3), expectedRevision: 0, mutationId: 'not-safe!',
    sent: true, next: null
  });
  disk.records.set(cacheKey(uid), bad);
  const sync = bind(disk, server);
  assert.equal(sync.load().error, 'cache_corrupt');
  await sync.flush();
  await sync.refresh();
  assert.equal(server.sent.length, 0);
  assert.equal(disk.records.get(cacheKey(uid)), bad);
});

test('an invalid conflict draft cannot be automatically discarded', async () => {
  const disk = storage(), server = api();
  const bad = persisted(snapshot(3), 1, null, {
    local: {notAWorklog: true}, server: snapshot(2),
    revision: 1, reason: 'stale_revision', resolved: false
  });
  disk.records.set(cacheKey(uid), bad);
  const sync = bind(disk, server);
  assert.equal(sync.load().error, 'cache_corrupt');
  await sync.resolveConflict('server');
  assert.equal(disk.records.get(cacheKey(uid)), bad);
});

test('recovering from a temporary read failure reloads the same pending draft and uploads once', async () => {
  const disk = storage(), server = api(), data = snapshot(3);
  const pending = {
    data, expectedRevision: 0, mutationId: 'a'.repeat(32),
    sent: false, next: null
  };
  disk.records.set(cacheKey(uid), persisted(data, 0, pending));
  disk.failReads(true);
  const sync = bind(disk, server);
  assert.equal(sync.load().error, 'cache_unreadable');
  assert.equal(sync.edit(snapshot(9)), false);
  await sync.flush();
  assert.equal(server.sent.length, 0);

  disk.failReads(false);
  assert.equal(sync.retryCache(), true);
  assert.equal(sync.load().error, null);
  assert.deepEqual(sync.load().data, data);
  assert.equal(sync.load().pending.mutationId, pending.mutationId);
  await sync.flush();
  assert.deepEqual(server.remote, {data, revision: 1});
  assert.equal(server.sent.length, 1);
  assert.equal(sync.load().pending, null);
});

test('manual restoration of a valid cached snapshot can recover a corrupted record', async () => {
  const disk = storage(), server = api();
  disk.records.set(cacheKey(uid), '{corrupted!');
  const sync = bind(disk, server);
  assert.equal(sync.retryCache(), false);
  const recovered = persisted(snapshot(4), 0, {
    data: snapshot(4), expectedRevision: 0, mutationId: 'b'.repeat(32),
    sent: false, next: null
  });
  disk.records.set(cacheKey(uid), recovered); // Explicit external repair, not app deletion.
  assert.equal(sync.retryCache(), true);
  await sync.flush();
  assert.deepEqual(server.remote, {data: snapshot(4), revision: 1});
});

test('read failure followed by missing cache stays blocked: never assume missing draft is disposable', async () => {
  const disk = storage(), server = api();
  disk.failReads(true);
  const sync = bind(disk, server);
  assert.equal(sync.load().error, 'cache_unreadable');
  disk.failReads(false);
  assert.equal(sync.retryCache(), false);
  assert.equal(sync.load().error, 'cache_unreadable');
  await sync.refresh();
  assert.equal(sync.edit(snapshot(2)), false);
  assert.equal(disk.records.has(cacheKey(uid)), false);
  assert.equal(server.sent.length, 0);
});

test('damage in one account cache cannot affect another account or overwrite the damaged bytes', async () => {
  const disk = storage(), server = api(), damaged = '{bad data';
  disk.records.set(cacheKey(uid), damaged);
  const locked = bind(disk, server);
  assert.equal(locked.load().error, 'cache_corrupt');
  const clean = bind(disk, server, other);
  await clean.refresh();
  assert.equal(clean.edit(snapshot(6)), true);
  await clean.flush();
  assert.equal(clean.load().revision, 1);
  assert.deepEqual(server.remote.data, snapshot(6));
  assert.equal(disk.records.get(cacheKey(uid)), damaged);
  assert.equal(locked.edit(snapshot(3)), false);
});

test('legacy missing optional pending and conflict fields remain readable', async () => {
  const disk = storage(), server = api();
  disk.records.set(cacheKey(uid), JSON.stringify({data: snapshot(2), revision: 2}));
  const sync = bind(disk, server);
  assert.equal(sync.load().error, null);
  assert.equal(sync.load().revision, 2);
  assert.equal(sync.load().pending, null);
  assert.equal(sync.load().conflict, null);
});

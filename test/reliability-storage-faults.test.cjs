'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../sync.js');

const uid = '00000000-0000-4000-8000-000000000077';
const key = 'worklog.yandex.test.v1:' + uid;
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

function flakyStorage() {
  const records = new Map();
  let fail = null;
  return {
    records,
    getItem: k => records.get(k) ?? null,
    setItem: (k, value) => {
      if (fail && fail(JSON.parse(value))) throw new Error('simulated local storage failure');
      records.set(k, value);
    },
    failWhen: fn => {fail = fn;},
    repair: () => {fail = null;}
  };
}

function server() {
  let data = null, revision = 0, commits = 0, available = true;
  const receipts = new Map(), attempts = [];
  return {
    api: {
      getWorklog: async () => {
        if (!available) throw new TypeError('network interrupted');
        return {data, revision};
      },
      putWorklog: async body => {
        attempts.push(body);
        if (!available) throw new TypeError('network interrupted');
        const receipt = receipts.get(body.mutationId);
        if (receipt) return receipt;
        if (body.expectedRevision !== revision) throw Object.assign(
          new Error('stale_revision'), {status: 409, code: 'stale_revision'}
        );
        data = body.data;
        revision++;
        commits++;
        const response = {revision, updatedAt: '2026-11-23T12:00:00Z'};
        receipts.set(body.mutationId, response);
        return response;
      }
    },
    disconnect: () => {available = false;},
    connect: () => {available = true;},
    attempts,
    state: () => ({data, revision, commits})
  };
}

function bind(disk, remote) {
  return create({uid, storage: disk, api: remote.api});
}

test('failed local write rejects the edit before any server request; user can retry after repair', async () => {
  const disk = flakyStorage(), remote = server();
  const app = bind(disk, remote);
  await app.refresh();
  const before = disk.records.get(key);
  assert.equal(app.load().revision, 0);

  disk.failWhen(() => true);
  assert.equal(app.edit(snapshot(3)), false);
  assert.equal(app.load().error, 'storage');
  assert.equal(app.load().data, null);
  await app.flush();
  assert.equal(remote.attempts.length, 0);
  assert.equal(disk.records.get(key), before);
  app.close();

  disk.repair();
  const restarted = bind(disk, remote);
  assert.equal(restarted.load().data, null);
  assert.equal(restarted.edit(snapshot(3)), true);
  await restarted.flush();
  assert.deepEqual(remote.state(), {data: snapshot(3), revision: 1, commits: 1});
  assert.equal(restarted.load().error, null);
});

test('failure to persist the sent flag prevents an unsafe upload and preserves the queued mutation', async () => {
  const disk = flakyStorage(), remote = server();
  const app = bind(disk, remote);
  await app.refresh();
  assert.equal(app.edit(snapshot(4)), true);
  const queued = app.load().pending;
  assert.equal(queued.sent, false);

  disk.failWhen(value => value.pending?.sent === true);
  await app.flush();
  assert.equal(app.load().error, 'storage');
  assert.equal(remote.attempts.length, 0);
  assert.equal(JSON.parse(disk.records.get(key)).pending.sent, false);
  app.close();

  disk.repair();
  const resumed = bind(disk, remote);
  assert.equal(resumed.load().pending.mutationId, queued.mutationId);
  await resumed.flush();
  assert.deepEqual(remote.state(), {data: snapshot(4), revision: 1, commits: 1});
  assert.equal(resumed.load().pending, null);
});

test('successful server commit plus failed local acknowledgement replays the exact mutation after cold start', async () => {
  const disk = flakyStorage(), remote = server();
  const app = bind(disk, remote);
  await app.refresh();
  assert.equal(app.edit(snapshot(5)), true);
  const id = app.load().pending.mutationId;

  // Phone runs out of space only after the server accepts the request.
  disk.failWhen(value => value.revision === 1 && value.pending === null);
  await app.flush();
  assert.equal(app.load().error, 'storage');
  assert.equal(app.load().pending.sent, true);
  assert.deepEqual(remote.state(), {data: snapshot(5), revision: 1, commits: 1});
  assert.equal(remote.attempts.length, 1);
  app.close();

  disk.repair();
  const resumed = bind(disk, remote);
  assert.equal(resumed.load().pending.mutationId, id);
  await resumed.flush();
  assert.equal(resumed.load().error, null);
  assert.equal(resumed.load().pending, null);
  assert.equal(resumed.load().revision, 1);
  assert.deepEqual(remote.attempts.map(write => write.mutationId), [id, id]);
  assert.equal(remote.state().commits, 1);
});

test('a second edit survives an acknowledgement storage fault and later syncs in order', async () => {
  const disk = flakyStorage(), remote = server();
  const originalWrite = remote.api.putWorklog;
  let firstResponse;
  let firstRequest;
  const requested = new Promise(resolve => {firstRequest = resolve;});
  const gate = new Promise(resolve => {firstResponse = resolve;});
  let hold = true;
  remote.api.putWorklog = async write => {
    const reply = await originalWrite(write);
    if (hold) {
      hold = false;
      firstRequest();
      await gate;
    }
    return reply;
  };

  const app = bind(disk, remote);
  await app.refresh();
  app.edit(snapshot(2));
  const firstId = app.load().pending.mutationId;
  const sending = app.flush();
  await requested;
  assert.equal(app.edit(snapshot(3)), true);
  assert.deepEqual(app.load().pending.next, snapshot(3));

  disk.failWhen(value => value.revision === 1);
  firstResponse();
  await sending;
  assert.equal(app.load().error, 'storage');
  assert.deepEqual(remote.state(), {data: snapshot(2), revision: 1, commits: 1});
  assert.deepEqual(JSON.parse(disk.records.get(key)).pending.next, snapshot(3));
  app.close();

  disk.repair();
  const reopened = bind(disk, remote);
  await reopened.flush();
  assert.deepEqual(remote.state(), {data: snapshot(3), revision: 2, commits: 2});
  assert.deepEqual(remote.attempts.map(x => x.expectedRevision), [0, 0, 1]);
  assert.deepEqual(remote.attempts.slice(0, 2).map(x => x.mutationId), [firstId, firstId]);
  assert.notEqual(remote.attempts[2].mutationId, firstId);
  assert.equal(reopened.load().pending, null);
  assert.equal(reopened.load().error, null);
});

test('network interruption preserves queued data and mutation identity through repeated restarts', async () => {
  const disk = flakyStorage(), remote = server();
  const initial = bind(disk, remote);
  await initial.refresh();
  initial.edit(snapshot(7));
  const id = initial.load().pending.mutationId;
  remote.disconnect();
  await initial.flush();
  assert.equal(initial.load().error, 'network');
  initial.close();

  const offline = bind(disk, remote);
  assert.deepEqual(offline.load().data, snapshot(7));
  await offline.flush();
  assert.equal(offline.load().error, 'network');
  assert.equal(offline.load().pending.mutationId, id);
  offline.close();

  remote.connect();
  const online = bind(disk, remote);
  await online.flush();
  assert.equal(online.load().revision, 1);
  assert.equal(online.load().pending, null);
  assert.deepEqual(remote.attempts.map(x => x.mutationId), [id, id, id]);
  assert.equal(remote.state().commits, 1);
});

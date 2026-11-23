'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {create: createApi} = require('../api.js');
const {create: createSync} = require('../sync.js');

const EMAIL = 'crossstack-employee@example.test';
const PASSWORD = 'synthetic crossstack password';
const BASE = 'https://synthetic.example.test';
const DAY = '2026-11-23';

function snapshot(hours) {
  return {
    version: 1,
    settings: {
      anchor: DAY, p1: 3, p2: 3, p3: 3,
      th1: 3, th2: 13, coef: 1.5,
      rates: {'1': 280, '2': 322, '3': 350}
    },
    days: {
      [DAY]: {date: DAY, main: {hours: String(hours), route: 1}}
    }
  };
}

function storage() {
  const disk = new Map();
  return {
    getItem: key => disk.get(key) ?? null,
    setItem: (key, value) => disk.set(key, value)
  };
}

function bridge(t) {
  const child = spawn('python3', ['backend/tests/support/crossstack_bridge.py'], {
    cwd: require('node:path').resolve(__dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}
  });
  const pending = [];
  let buffer = '', error = '', stopped = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', part => {
    buffer += part;
    while(buffer.includes('\n')) {
      const cut = buffer.indexOf('\n');
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      const next = pending.shift();
      if(next) {
        try {next.resolve(JSON.parse(line));}
        catch(e) {next.reject(e);}
      }
    }
  });
  child.stderr.on('data', part => {error += part;});
  child.on('error', e => {
    stopped = true;
    while(pending.length) pending.shift().reject(e);
  });
  child.on('exit', code => {
    stopped = true;
    while(pending.length) pending.shift().reject(
      new Error('Synthetic backend terminated (' + code + '): ' + error.slice(0, 1000)));
  });
  t.after(() => {
    child.stdin.end();
    if(!stopped) child.kill();
  });
  return command => new Promise((resolve, reject) => {
    if(stopped) return reject(new Error('Synthetic backend has exited'));
    pending.push({resolve, reject});
    child.stdin.write(JSON.stringify(command) + '\n');
  });
}

function device(rpc) {
  let online = true, loseSuccessOnce = false;
  const sent = [];
  const fetch = async (url, opts) => {
    if(!online) throw new TypeError('network disconnected');
    const path = new URL(url).pathname;
    const payload = await rpc({
      op: 'http', path, method: opts.method,
      headers: opts.headers, body: opts.body
    });
    if(opts.method === 'PUT' && path === '/me/worklog') {
      sent.push(JSON.parse(opts.body));
      if(loseSuccessOnce && payload.statusCode === 200) {
        loseSuccessOnce = false;
        throw new TypeError('successful server response lost in transit');
      }
    }
    return Response.json(payload.body, {status: payload.statusCode});
  };
  const api = createApi({baseUrl: BASE, fetch});
  const disk = storage();
  return {
    api, disk, sent,
    offline: () => {online = false;},
    online: () => {online = true;},
    loseNextSuccess: () => {loseSuccessOnce = true;},
    sync: uid => createSync({uid, storage: disk, api,
      canSend: () => online,
      canRefresh: () => online
    })
  };
}

test('real frontend API and backend preserve an offline draft across restart and server conflict', async t => {
  const rpc = bridge(t);
  const first = device(rpc), second = device(rpc);
  const person1 = await first.api.login(EMAIL, PASSWORD);
  const person2 = await second.api.login(EMAIL, PASSWORD);
  assert.equal(person1.uid, person2.uid);
  const a = first.sync(person1.uid), b = second.sync(person2.uid);
  await Promise.all([a.refresh(), b.refresh()]);
  assert.equal(a.load().revision, 0);
  assert.equal(b.load().revision, 0);

  a.edit(snapshot(2));
  await a.flush();
  assert.equal(a.load().revision, 1);
  await b.refresh();
  assert.equal(b.load().revision, 1);

  second.offline();
  b.edit(snapshot(3));
  assert.equal(b.load().data.days[DAY].main.hours, '3');
  b.close();

  a.edit(snapshot(4));
  await a.flush();
  assert.equal(a.load().revision, 2);

  const restarted = second.sync(person2.uid);
  assert.equal(restarted.load().data.days[DAY].main.hours, '3');
  second.online();
  await restarted.flush();
  assert.equal(restarted.load().conflict.reason, 'stale_revision');
  assert.deepEqual(restarted.load().conflict.local, snapshot(3));
  assert.deepEqual(restarted.load().conflict.server, snapshot(4));

  const remoteBefore = await first.api.getWorklog();
  assert.equal(remoteBefore.revision, 2);
  assert.deepEqual(remoteBefore.data, snapshot(4));

  await restarted.resolveConflict('retry-local');
  assert.equal(restarted.load().revision, 3);
  assert.equal(restarted.load().pending, null);
  assert.equal(restarted.load().conflict, null);
  assert.deepEqual((await first.api.getWorklog()).data, snapshot(3));
  assert.deepEqual(second.sent.map(w => w.expectedRevision), [1, 2]);
  assert.notEqual(second.sent[0].mutationId, second.sent[1].mutationId);
});

test('real backend deduplicates a persisted mutation after a lost HTTP response and restart', async t => {
  const rpc = bridge(t);
  const d = device(rpc);
  const person = await d.api.login(EMAIL, PASSWORD);
  const original = d.sync(person.uid);
  await original.refresh();
  d.loseNextSuccess();
  original.edit(snapshot(5));
  await original.flush();
  assert.equal(original.load().error, 'network');
  const sent = original.load().pending;
  assert.ok(sent);
  assert.equal(sent.sent, true);
  const afterWrite = await d.api.getWorklog();
  assert.equal(afterWrite.revision, 1);

  original.close();
  const reopened = d.sync(person.uid);
  await reopened.flush();
  assert.equal(reopened.load().revision, 1);
  assert.equal(reopened.load().pending, null);
  assert.equal(reopened.load().error, null);
  assert.equal(d.sent.length, 2);
  assert.equal(d.sent[0].mutationId, d.sent[1].mutationId);
  assert.equal(d.sent[0].expectedRevision, d.sent[1].expectedRevision);
  assert.deepEqual(await d.api.getWorklog(),
    {data: snapshot(5), revision: 1});
});

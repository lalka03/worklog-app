const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const endpoint = process.env.WORKLOG_API_BASE_URL ?? '';
const originPattern = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)\/?$/i;
const match = endpoint.match(originPattern);
const hostname = match?.[1].toLowerCase();
const reservedHost = /(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|local|localhost|test|internal)$/;

if (!match || match[0] !== endpoint || hostname.length > 253 ||
    reservedHost.test(hostname) || !URL.canParse(endpoint)) {
  console.error('WORKLOG_API_BASE_URL must be the approved public HTTPS gateway origin.');
  process.exit(1);
}

const html = readFileSync('index.html', 'utf8').split(/^const WORKLOG_API_BASE_URL = '';$/m);
if (html.length !== 2) {
  console.error('index.html must contain exactly one empty URL marker.');
  process.exit(1);
}

const origin = new URL(endpoint).origin;
const files = new Map([
  ['index.html', html.join(`const WORKLOG_API_BASE_URL = ${JSON.stringify(origin)};`)],
  ['account.js', readFileSync('account.js')],
  ['api.js', readFileSync('api.js')],
  ['sync.js', readFileSync('sync.js')],
]);

// Require a fresh staging directory so older releases cannot supply extra files.
mkdirSync('www');
for (const [name, contents] of files) {
  writeFileSync(join('www', name), contents);
}

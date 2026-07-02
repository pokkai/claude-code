'use strict';

/*
 * Spec: /healthz is the only unauthenticated endpoint; every response
 * carries the hardening headers (CSP default-src 'self', nosniff,
 * X-Frame-Options DENY, no-store); the server refuses to start without a
 * usable INGEST_TOKEN.
 */

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

const { startServer, connectionClient } = require('./helpers');

let server;
let client;

before(async () => {
  server = await startServer();
  client = connectionClient(server.port);
});

after(() => {
  client.close();
  server.stop();
});

test('healthz responds 200 without any authentication', async () => {
  const res = await client.request('GET', '/healthz');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body.toString()).status, 'ok');
});

test('responses carry the security headers', async () => {
  const res = await client.request('GET', '/healthz');
  assert.match(res.headers['content-security-policy'] || '', /default-src 'self'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.match(res.headers['cache-control'] || '', /no-store/);
  assert.equal(res.headers['x-powered-by'], undefined, 'must not advertise the framework');
});

test('refuses to start without INGEST_TOKEN', async () => {
  await assert.rejects(
    () => startServer({ INGEST_TOKEN: undefined }),
    /exited/,
    'server must exit when no ingest token is configured',
  );
});

test('refuses to start with a short INGEST_TOKEN', async () => {
  await assert.rejects(
    () => startServer({ INGEST_TOKEN: 'short' }),
    /exited/,
    'server must exit when the ingest token is too short',
  );
});

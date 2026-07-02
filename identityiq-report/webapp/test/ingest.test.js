'use strict';

/*
 * Spec: POST /api/ingest — bearer-token auth (constant-time), report type
 * from X-Report-Name header or ?name=, sanitized directory names (no
 * traversal), body streamed to DATA_DIR/<type>/<timestamp>.csv, size cap
 * with partial-file cleanup, 201 with {reportType, file, bytes}, rate
 * limiting on repeated auth failures.
 */

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fs = require('fs');
const path = require('path');

const { TEST_TOKEN, startServer, connectionClient } = require('./helpers');

let server;
let client;

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'text/csv', ...extra };
}

before(async () => {
  server = await startServer();
  client = connectionClient(server.port);
});

after(() => {
  client.close();
  server.stop();
});

test('rejects a missing bearer token with 401', async () => {
  const res = await client.request('POST', '/api/ingest', { body: 'a,b\n1,2\n' });
  assert.equal(res.status, 401);
});

test('rejects a wrong bearer token with 401', async () => {
  const res = await client.request('POST', '/api/ingest', {
    headers: { Authorization: 'Bearer wrong-token-0123456789abcdef' },
    body: 'a,b\n1,2\n',
  });
  assert.equal(res.status, 401);
});

test('stores a CSV under the X-Report-Name type and returns 201 with metadata', async () => {
  const csv = 'Business Role,IT Role,Entitlement\nBR-1,ITR-1,ent-1\n';
  const res = await client.request('POST', '/api/ingest', {
    headers: authHeaders({ 'X-Report-Name': 'Role Relationships' }),
    body: csv,
  });
  assert.equal(res.status, 201);
  const parsed = JSON.parse(res.body.toString());
  assert.equal(parsed.reportType, 'Role Relationships');
  assert.equal(parsed.bytes, Buffer.byteLength(csv));
  assert.match(parsed.file, /\.csv$/);

  const stored = fs.readFileSync(path.join(server.dataDir, parsed.reportType, parsed.file), 'utf8');
  assert.equal(stored, csv);
});

test('accepts the report type from the ?name= query parameter', async () => {
  const res = await client.request('POST', '/api/ingest?name=Uncorrelated%20Accounts', {
    headers: authHeaders(),
    body: 'Name,Value\nalpha,1\n',
  });
  assert.equal(res.status, 201);
  assert.equal(JSON.parse(res.body.toString()).reportType, 'Uncorrelated Accounts');
});

test('sanitizes hostile report names so nothing is written outside DATA_DIR', async () => {
  const res = await client.request('POST', '/api/ingest', {
    headers: authHeaders({ 'X-Report-Name': '../../etc' }),
    body: 'a,b\n1,2\n',
  });
  assert.equal(res.status, 201);
  const { reportType, file } = JSON.parse(res.body.toString());
  assert.ok(!reportType.includes('..'), `sanitized name must not contain "..": ${reportType}`);
  // The stored file resolves inside DATA_DIR.
  const resolved = fs.realpathSync(path.join(server.dataDir, reportType, file));
  assert.ok(resolved.startsWith(fs.realpathSync(server.dataDir) + path.sep));
  // And nothing appeared one level above the data dir.
  assert.ok(!fs.existsSync(path.join(server.dataDir, '..', 'etc')));
});

test('a >10MB upload is stored byte-identical', async () => {
  const row = 'BR-x,ITR-y,entitlement-value-with-padding-0123456789\n';
  const big = Buffer.from('Business Role,IT Role,Entitlement\n' + row.repeat(300000));
  assert.ok(big.length > 10 * 1024 * 1024, 'fixture must exceed 10MB');

  const res = await client.request('POST', '/api/ingest', {
    headers: authHeaders({ 'X-Report-Name': 'Big Report' }),
    body: big,
  });
  assert.equal(res.status, 201);
  const { reportType, file, bytes } = JSON.parse(res.body.toString());
  assert.equal(bytes, big.length);
  const stored = fs.readFileSync(path.join(server.dataDir, reportType, file));
  assert.ok(stored.equals(big), 'stored bytes must match the uploaded bytes');
});

test('an upload above MAX_UPLOAD_MB is rejected and leaves no partial file', async () => {
  const capped = await startServer({ MAX_UPLOAD_MB: '1' });
  const cappedClient = connectionClient(capped.port);
  try {
    const tooBig = Buffer.alloc(2 * 1024 * 1024, 'x');
    let status = null;
    try {
      const res = await cappedClient.request('POST', '/api/ingest', {
        headers: authHeaders({ 'X-Report-Name': 'Too Big' }),
        body: tooBig,
      });
      status = res.status;
    } catch (err) {
      // The server may cut the connection mid-upload; that also counts as
      // rejection as long as nothing is left on disk.
      status = 'connection-terminated';
    }
    if (typeof status === 'number') assert.equal(status, 413);

    const typeDir = path.join(capped.dataDir, 'Too Big');
    await new Promise((r) => setTimeout(r, 200)); // allow async unlink
    const leftovers = fs.existsSync(typeDir) ? fs.readdirSync(typeDir) : [];
    assert.deepEqual(leftovers, [], 'partial upload must be cleaned up');
  } finally {
    cappedClient.close();
    capped.stop();
  }
});

test('repeated bad-token attempts are rate limited with 429', async () => {
  const limited = await startServer();
  const limitedClient = connectionClient(limited.port);
  try {
    let sawTooMany = false;
    for (let i = 0; i < 40; i++) {
      const res = await limitedClient.request('POST', '/api/ingest', {
        headers: { Authorization: 'Bearer nope-nope-nope-nope' },
        body: 'x',
      });
      if (res.status === 429) { sawTooMany = true; break; }
      assert.equal(res.status, 401);
    }
    assert.ok(sawTooMany, 'expected a 429 after repeated auth failures');
  } finally {
    limitedClient.close();
    limited.stop();
  }
});

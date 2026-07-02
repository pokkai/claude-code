'use strict';

/*
 * Spec: viewer API and SPA assets sit behind NTLM *identification* —
 * unverified claimed identity, connection-scoped, deny (401 + NTLM
 * challenge) for anything that does not complete the handshake.
 * /api/me returns the claimed UPN with verified:false; /api/reports lists
 * types/files with metadata; /api/reports/:type/:file streams text/csv
 * (?download adds Content-Disposition); traversal is rejected.
 */

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

const {
  TEST_TOKEN,
  startServer,
  connectionClient,
  ntlmType3,
  ntlmHandshake,
} = require('./helpers');

let server;

before(async () => {
  server = await startServer();
  // Seed one report through the public ingest contract.
  const seed = connectionClient(server.port);
  const res = await seed.request('POST', '/api/ingest', {
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'X-Report-Name': 'Role Relationships' },
    body: 'Business Role,IT Role,Entitlement\nBR-1,ITR-1,ent-1\n',
  });
  assert.equal(res.status, 201);
  seed.close();
});

after(() => server.stop());

test('viewer API without credentials is denied with an NTLM challenge', async () => {
  const client = connectionClient(server.port);
  try {
    for (const urlPath of ['/api/reports', '/api/me', '/']) {
      const res = await client.request('GET', urlPath);
      assert.equal(res.status, 401, `${urlPath} must deny unauthenticated access`);
      assert.match(res.headers['www-authenticate'] || '', /NTLM/);
    }
  } finally {
    client.close();
  }
});

test('NTLM handshake: Type 1 gets a Type 2 challenge, Type 3 authenticates the connection', async () => {
  const client = connectionClient(server.port);
  try {
    const { step1, challenge, step2 } = await ntlmHandshake(client, 'CORP', 'tester', '/api/me');
    assert.equal(step1.status, 401);
    assert.match(challenge, /^NTLM [A-Za-z0-9+/=]+$/, 'challenge must be an NTLM base64 blob');
    const type2 = Buffer.from(challenge.split(' ')[1], 'base64');
    assert.equal(type2.toString('latin1', 0, 8), 'NTLMSSP\0');
    assert.equal(type2.readUInt32LE(8), 2, 'challenge must be a Type 2 message');

    assert.equal(step2.status, 200);
    const me = JSON.parse(step2.body.toString());
    assert.equal(me.upn, 'tester@CORP');
    assert.equal(me.verified, false, 'identity must be reported as unverified');

    // Same connection stays identified without re-handshaking.
    const followUp = await client.request('GET', '/api/me');
    assert.equal(followUp.status, 200);
    assert.equal(JSON.parse(followUp.body.toString()).upn, 'tester@CORP');
  } finally {
    client.close();
  }
});

test('lists report types and files with size and timestamp metadata', async () => {
  const client = connectionClient(server.port);
  try {
    await ntlmHandshake(client, 'CORP', 'tester');
    const res = await client.request('GET', '/api/reports');
    assert.equal(res.status, 200);
    const { reportTypes } = JSON.parse(res.body.toString());
    const entry = reportTypes.find((t) => t.reportType === 'Role Relationships');
    assert.ok(entry, 'seeded report type must be listed');
    assert.equal(entry.files.length, 1);
    const file = entry.files[0];
    assert.match(file.name, /\.csv$/);
    assert.ok(file.bytes > 0);
    assert.ok(!Number.isNaN(Date.parse(file.receivedAt)), 'receivedAt must be a timestamp');
  } finally {
    client.close();
  }
});

test('streams a stored CSV back, with attachment disposition on ?download', async () => {
  const client = connectionClient(server.port);
  try {
    await ntlmHandshake(client, 'CORP', 'tester');
    const list = JSON.parse((await client.request('GET', '/api/reports')).body.toString());
    const fileName = list.reportTypes.find((t) => t.reportType === 'Role Relationships').files[0].name;
    const base = `/api/reports/${encodeURIComponent('Role Relationships')}/${encodeURIComponent(fileName)}`;

    const view = await client.request('GET', base);
    assert.equal(view.status, 200);
    assert.match(view.headers['content-type'], /text\/csv/);
    assert.match(view.body.toString(), /^Business Role,IT Role,Entitlement/);
    assert.ok(!view.headers['content-disposition'], 'no attachment header without ?download');

    const download = await client.request('GET', `${base}?download`);
    assert.equal(download.status, 200);
    assert.match(download.headers['content-disposition'] || '', /attachment/);
  } finally {
    client.close();
  }
});

test('rejects traversal and unknown files without disclosure', async () => {
  const client = connectionClient(server.port);
  try {
    await ntlmHandshake(client, 'CORP', 'tester');

    const traversal = await client.request('GET', '/api/reports/..%2f..%2fetc/passwd.csv');
    assert.ok(traversal.status >= 400 && traversal.status < 500, `traversal must be rejected, got ${traversal.status}`);
    assert.ok(!traversal.body.toString().includes('root:'), 'must not leak file contents');

    const missing = await client.request('GET', '/api/reports/Role%20Relationships/nope.csv');
    assert.equal(missing.status, 404);
  } finally {
    client.close();
  }
});

test('malformed NTLM tokens are denied without crashing the server', async () => {
  const client = connectionClient(server.port);
  try {
    const garbage = await client.request('GET', '/api/me', {
      headers: { Authorization: 'NTLM !!!!not-base64!!!!' },
    });
    assert.equal(garbage.status, 401);

    const wrongSignature = await client.request('GET', '/api/me', {
      headers: { Authorization: 'NTLM ' + Buffer.from('BOGUS!!\0\x03\0\0\0').toString('base64') },
    });
    assert.equal(wrongSignature.status, 401);

    // Type 3 with an empty username claim is not an identity.
    const emptyUser = await client.request('GET', '/api/me', {
      headers: { Authorization: 'NTLM ' + ntlmType3('CORP', '').toString('base64') },
    });
    assert.equal(emptyUser.status, 401);

    // Server is still alive and consistent afterwards.
    const alive = await connectionClient(server.port).request('GET', '/healthz');
    assert.equal(alive.status, 200);
  } finally {
    client.close();
  }
});

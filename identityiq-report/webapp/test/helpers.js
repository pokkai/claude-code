'use strict';

/*
 * Test harness. Everything here is derived from the approved plan
 * (docs/plans/2026-07-02-report-post-rule-and-dashboard-app.md), not from
 * the implementation: the server is exercised as a black box over HTTP.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'index.js');
const TEST_TOKEN = 'regression-test-token-0123456789';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

/**
 * Boot server/index.js as a child process with an isolated DATA_DIR and
 * port. Resolves once the process is accepting connections; rejects if it
 * exits first (useful for the refuses-to-start tests).
 */
async function startServer(envOverrides = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iiq-report-test-'));
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    INGEST_TOKEN: TEST_TOKEN,
    ...envOverrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) delete env[key];
  }

  const child = spawn(process.execPath, [SERVER_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    child.once('exit', (code) => reject(new Error(`server exited with code ${code}: ${output}`)));
    (function probe() {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); child.removeAllListeners('exit'); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`server did not listen in time: ${output}`));
        else setTimeout(probe, 100);
      });
    })();
  });

  return {
    port,
    dataDir,
    getOutput: () => output,
    stop() {
      child.kill('SIGTERM');
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * HTTP client bound to ONE keep-alive TCP connection. NTLM identity is
 * connection-scoped per the plan, so handshake steps must share a socket.
 */
function connectionClient(port) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  return {
    request(method, urlPath, { headers = {}, body = null } = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, method, path: urlPath, headers, agent },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () =>
              resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
          },
        );
        req.on('error', reject);
        if (body !== null) req.write(body);
        req.end();
      });
    },
    close() {
      agent.destroy();
    },
  };
}

/* ---- NTLM message builders (from the protocol layout in the plan) ---- */

const NTLM_SIGNATURE = 'NTLMSSP\0';

function ntlmType1() {
  const buf = Buffer.alloc(16);
  buf.write(NTLM_SIGNATURE, 0, 'latin1');
  buf.writeUInt32LE(1, 8);
  return buf;
}

/** Type 3 AUTHENTICATE with claimed domain/user, UTF-16LE, flags at 60. */
function ntlmType3(domain, user) {
  const domainBytes = Buffer.from(domain, 'utf16le');
  const userBytes = Buffer.from(user, 'utf16le');
  const headerLen = 64;
  const buf = Buffer.alloc(headerLen + domainBytes.length + userBytes.length);
  buf.write(NTLM_SIGNATURE, 0, 'latin1');
  buf.writeUInt32LE(3, 8);

  const writeSecBuf = (at, len, offset) => {
    buf.writeUInt16LE(len, at);
    buf.writeUInt16LE(len, at + 2);
    buf.writeUInt32LE(offset, at + 4);
  };
  writeSecBuf(12, 0, headerLen); // LmChallengeResponse (empty)
  writeSecBuf(20, 0, headerLen); // NtChallengeResponse (empty)
  writeSecBuf(28, domainBytes.length, headerLen); // DomainName
  writeSecBuf(36, userBytes.length, headerLen + domainBytes.length); // UserName
  writeSecBuf(44, 0, headerLen); // Workstation (empty)
  writeSecBuf(52, 0, headerLen); // SessionKey (empty)
  buf.writeUInt32LE(0x00000001, 60); // flags: NEGOTIATE_UNICODE

  domainBytes.copy(buf, headerLen);
  userBytes.copy(buf, headerLen + domainBytes.length);
  return buf;
}

/**
 * Run the full NTLM identification handshake on the given single-connection
 * client, claiming DOMAIN\user, ending with an authenticated GET of urlPath.
 */
async function ntlmHandshake(client, domain, user, urlPath = '/api/me') {
  const step1 = await client.request('GET', urlPath, {
    headers: { Authorization: 'NTLM ' + ntlmType1().toString('base64') },
  });
  if (step1.status !== 401) return { step1, step2: null };
  const challenge = step1.headers['www-authenticate'];
  const step2 = await client.request('GET', urlPath, {
    headers: { Authorization: 'NTLM ' + ntlmType3(domain, user).toString('base64') },
  });
  return { step1, challenge, step2 };
}

module.exports = {
  TEST_TOKEN,
  startServer,
  connectionClient,
  ntlmType1,
  ntlmType3,
  ntlmHandshake,
};

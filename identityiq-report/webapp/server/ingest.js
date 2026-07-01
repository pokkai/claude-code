'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('./config');

// Constant-time token comparison over fixed-length digests so neither the
// value nor the length of the configured token leaks through timing.
function tokenMatches(presented) {
  const a = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const b = crypto.createHash('sha256').update(config.ingestToken, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// Small in-memory rate limit on failed ingest auth to blunt token guessing.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 20;
const authFailures = new Map(); // ip -> [timestamps]

function tooManyFailures(ip) {
  const now = Date.now();
  const recent = (authFailures.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  authFailures.set(ip, recent);
  return recent.length >= FAIL_LIMIT;
}

function recordFailure(ip) {
  const list = authFailures.get(ip) || [];
  list.push(Date.now());
  authFailures.set(ip, list);
}

// Report names become directory names; allow only a conservative charset.
function sanitizeReportName(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^A-Za-z0-9 _.-]/g, '_')
    .replace(/\.+/g, '.') // collapse dot runs; "." / ".." can't survive this + charset filter
    .slice(0, 100)
    .trim();
  return cleaned && cleaned !== '.' ? cleaned : 'unnamed';
}

function ingest(req, res) {
  const ip = req.ip;

  if (tooManyFailures(ip)) {
    return res.status(429).json({ error: 'Too many failed authentication attempts' });
  }

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7))) {
    recordFailure(ip);
    console.warn(`[ingest] rejected upload from ${ip}: bad or missing bearer token`);
    return res.status(401).json({ error: 'Invalid or missing bearer token' });
  }

  const reportType = sanitizeReportName(req.get('X-Report-Name') || req.query.name);
  const typeDir = path.join(config.dataDir, reportType);
  fs.mkdirSync(typeDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${timestamp}.csv`;
  const filePath = path.join(typeDir, fileName);

  const out = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o640 });
  let received = 0;
  let finished = false;

  function fail(status, message) {
    if (finished) return;
    finished = true;
    req.unpipe(out);
    out.destroy();
    fs.unlink(filePath, () => {});
    if (!res.headersSent) {
      res.status(status).json({ error: message });
    }
    req.destroy();
  }

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > config.maxUploadBytes) {
      console.warn(`[ingest] upload for '${reportType}' from ${ip} exceeded ${config.maxUploadBytes} bytes`);
      fail(413, 'Payload too large');
    }
  });

  req.on('aborted', () => {
    console.warn(`[ingest] upload for '${reportType}' from ${ip} aborted after ${received} bytes`);
    fail(400, 'Upload aborted');
  });

  out.on('error', (err) => {
    console.error(`[ingest] write error for ${filePath}: ${err.message}`);
    fail(500, 'Failed to store report');
  });

  out.on('finish', () => {
    if (finished) return;
    finished = true;
    console.log(`[ingest] stored ${reportType}/${fileName} (${received} bytes) from ${ip}`);
    res.status(201).json({ reportType, file: fileName, bytes: received });
  });

  req.pipe(out);
}

module.exports = { ingest };

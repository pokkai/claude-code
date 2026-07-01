'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const config = require('./config');
const { ntlmIdent } = require('./ntlm-ident');
const { ingest } = require('./ingest');
const { listReports, getReport } = require('./reports');

const app = express();
app.disable('x-powered-by');
// TLS terminates at the reverse proxy in front of this container; trust it
// for correct client IPs in the audit log.
app.set('trust proxy', true);

// Security headers on every response. The SPA is same-origin only.
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'no-store');
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms ip=${req.ip} user=${req.user ? req.user.upn : '-'}`);
  });
  next();
});

// Unauthenticated: container/orchestrator health checks only.
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Machine endpoint for the IdentityIQ rule — bearer token, not NTLM.
app.post('/api/ingest', ingest);

// Everything else (viewer API + SPA assets) requires the NTLM handshake.
// See ntlm-ident.js: this is unverified identification, risk accepted.
app.use(ntlmIdent);

app.get('/api/me', (req, res) => {
  res.json({ upn: req.user.upn, verified: false });
});
app.get('/api/reports', listReports);
app.get('/api/reports/:type/:file', getReport);

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

// SPA fallback for hash-less deep links; API misses stay JSON 404s.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

fs.mkdirSync(config.dataDir, { recursive: true });

app.listen(config.port, () => {
  console.log(`identityiq-report-receiver listening on :${config.port}, data dir ${config.dataDir}`);
});

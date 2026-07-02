'use strict';

const path = require('path');

function intEnv(name, fallback) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const config = {
  port: intEnv('PORT', 8080),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  // Shared secret the IdentityIQ rule sends as "Authorization: Bearer ...".
  ingestToken: process.env.INGEST_TOKEN || '',
  maxUploadBytes: intEnv('MAX_UPLOAD_MB', 200) * 1024 * 1024,
};

if (!config.ingestToken) {
  console.error('FATAL: INGEST_TOKEN is not set. Refusing to start without ingest authentication.');
  process.exit(1);
}
if (config.ingestToken.length < 16) {
  console.error('FATAL: INGEST_TOKEN must be at least 16 characters.');
  process.exit(1);
}

module.exports = config;

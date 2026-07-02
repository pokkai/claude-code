'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');

// Same conservative charset the ingest side produces; anything else is a
// crafted URL, not a stored report.
const SAFE_NAME = /^[A-Za-z0-9 _.-]{1,100}$/;

function isSafe(name) {
  return SAFE_NAME.test(name) && !name.includes('..');
}

function listReports(req, res) {
  const types = [];
  let entries = [];
  try {
    entries = fs.readdirSync(config.dataDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafe(entry.name)) continue;
    const typeDir = path.join(config.dataDir, entry.name);
    const files = fs
      .readdirSync(typeDir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.csv') && isSafe(f.name))
      .map((f) => {
        const stat = fs.statSync(path.join(typeDir, f.name));
        return { name: f.name, bytes: stat.size, receivedAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    types.push({ reportType: entry.name, files });
  }

  types.sort((a, b) => a.reportType.localeCompare(b.reportType));
  res.json({ reportTypes: types });
}

function getReport(req, res) {
  const { type, file } = req.params;
  if (!isSafe(type) || !isSafe(file) || !file.endsWith('.csv')) {
    return res.status(400).json({ error: 'Invalid report reference' });
  }

  const filePath = path.join(config.dataDir, type, file);
  if (!filePath.startsWith(config.dataDir + path.sep)) {
    return res.status(400).json({ error: 'Invalid report reference' });
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return res.status(404).json({ error: 'Report not found' });
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Length', String(stat.size));
    if (req.query.download !== undefined) {
      res.set('Content-Disposition', `attachment; filename="${type}-${file}"`);
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

module.exports = { listReports, getReport };

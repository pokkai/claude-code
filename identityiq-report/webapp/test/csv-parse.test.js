'use strict';

/*
 * Spec: the generic dashboard parses report CSVs per RFC 4180 — quoted
 * fields, escaped quotes, CRLF line endings, embedded commas/newlines —
 * and truncates at a row cap, flagging the truncation.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('url');
const path = require('path');

const csvModule = pathToFileURL(path.join(__dirname, '..', 'public', 'dashboards', 'csv.mjs')).href;

async function parse(text, maxRows) {
  const { parseCsv } = await import(csvModule);
  return parseCsv(text, maxRows);
}

test('parses plain rows and columns', async () => {
  const { rows, truncated } = await parse('a,b,c\n1,2,3\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.equal(truncated, false);
});

test('handles quoted fields with embedded commas and newlines', async () => {
  const { rows } = await parse('name,desc\n"Smith, Jane","line one\nline two"\n');
  assert.deepEqual(rows, [['name', 'desc'], ['Smith, Jane', 'line one\nline two']]);
});

test('unescapes doubled quotes inside quoted fields', async () => {
  const { rows } = await parse('q\n"say ""hi"" now"\n');
  assert.deepEqual(rows, [['q'], ['say "hi" now']]);
});

test('accepts CRLF line endings', async () => {
  const { rows } = await parse('a,b\r\n1,2\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('parses a final row without a trailing newline', async () => {
  const { rows } = await parse('a,b\n1,2');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('returns no rows for empty input', async () => {
  const { rows, truncated } = await parse('');
  assert.deepEqual(rows, []);
  assert.equal(truncated, false);
});

test('truncates at the row cap and flags it', async () => {
  const text = Array.from({ length: 100 }, (_, i) => `row${i}`).join('\n') + '\n';
  const { rows, truncated } = await parse(text, 10);
  assert.equal(truncated, true);
  assert.ok(rows.length <= 11, 'must stop reading shortly after the cap');
});

test('does not truncate below the cap', async () => {
  const { truncated } = await parse('a\nb\nc\n', 10);
  assert.equal(truncated, false);
});

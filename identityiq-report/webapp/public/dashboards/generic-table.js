/*
 * Default dashboard: renders any report CSV as a table, capped at MAX_ROWS
 * to keep large reports responsive (full data via the Download button).
 * All cell content is inserted via textContent, never innerHTML, so CSV
 * data cannot inject markup. Parsing lives in csv.js.
 */

import { el } from '/app.js';
import { parseCsv } from './csv.mjs';

const MAX_ROWS = 500;

export async function render(container, ctx) {
  container.replaceChildren(el('p', { class: 'muted', text: 'Loading report…' }));

  const res = await fetch(ctx.dataUrl);
  if (!res.ok) throw new Error(`Failed to load report: HTTP ${res.status}`);
  const text = await res.text();

  const { rows, truncated } = parseCsv(text, MAX_ROWS);
  if (rows.length === 0) {
    container.replaceChildren(el('p', { class: 'muted', text: 'Report is empty.' }));
    return;
  }

  const [header, ...body] = rows;
  const table = el('table', { class: 'report' }, [
    el('thead', {}, [el('tr', {}, header.map((h) => el('th', { text: h })))]),
    el('tbody', {}, body.slice(0, MAX_ROWS).map((r) => el('tr', {}, r.map((c) => el('td', { text: c }))))),
  ]);

  const nodes = [el('div', { class: 'table-wrap' }, [table])];
  if (truncated) {
    nodes.push(el('p', { class: 'muted', text: `Showing first ${MAX_ROWS} rows — download the CSV for the full report.` }));
  }
  container.replaceChildren(...nodes);
}

/*
 * Default dashboard: renders any report CSV as a table, capped at MAX_ROWS
 * to keep large reports responsive (full data via the Download button).
 * All cell content is inserted via textContent, never innerHTML, so CSV
 * data cannot inject markup.
 */

import { el } from '/app.js';

const MAX_ROWS = 500;

// Minimal RFC 4180 parser: quoted fields, escaped quotes, CR/LF endings.
export function parseCsv(text, maxRows = Infinity) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') pushField();
    else if (ch === '\n') {
      pushRow();
      if (rows.length > maxRows) return { rows, truncated: true };
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length > 0) pushRow();
  return { rows, truncated: false };
}

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

/*
 * Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CR/LF
 * endings. Pure module (no DOM, no imports) so dashboards and the Node
 * test suite share it.
 */

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

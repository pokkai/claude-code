/*
 * Dashboard stub: relationship between business roles, IT roles and
 * entitlements.
 *
 * The visualization (e.g. a hierarchy/graph of business role -> IT role ->
 * entitlement) will be implemented once sample report data is available.
 * Until then this renders a notice plus the generic table so the received
 * data is still inspectable.
 *
 * Expected implementation sketch:
 *   - fetch(ctx.dataUrl), parse with parseCsv from csv.mjs
 *   - group rows by business role, then IT role, aggregate entitlements
 *   - render an expandable tree or adjacency diagram
 */

import { el } from '/app.js';
import * as genericTable from '/dashboards/generic-table.js';

export async function render(container, ctx) {
  const notice = el('div', { class: 'notice' }, [
    el('strong', { text: 'Role Relationships dashboard — visualization pending. ' }),
    el('span', { text: 'The business role / IT role / entitlement visualization will be built once sample report data is available. Showing the raw data below.' }),
  ]);
  const tableContainer = el('div');
  container.replaceChildren(notice, el('div', { class: 'spacer' }), tableContainer);
  await genericTable.render(tableContainer, ctx);
}

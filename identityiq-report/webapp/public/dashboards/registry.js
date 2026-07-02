/*
 * Dashboard registry: maps a report type (the sanitized IdentityIQ report
 * name sent in X-Report-Name) to the module that visualizes it.
 *
 * To add a dashboard for a new report:
 *   1. Create a module in this directory exporting { render(container, ctx) }.
 *      ctx = { type, file, dataUrl } — fetch ctx.dataUrl for the CSV.
 *   2. Register it below under the exact report type name.
 * Unregistered report types fall back to the generic table view.
 */

import * as genericTable from '/dashboards/generic-table.js';
import * as roleRelationships from '/dashboards/role-relationships.js';

const registry = new Map([
  ['Role Relationships', roleRelationships],
]);

export function dashboardFor(reportType) {
  return registry.get(reportType) || genericTable;
}

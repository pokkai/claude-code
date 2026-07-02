import { dashboardFor } from '/dashboards/registry.js';

const app = document.getElementById('app');

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} failed: HTTP ${res.status}`);
  return res.json();
}

function renderError(err) {
  app.replaceChildren(el('p', { class: 'error', text: `Error: ${err.message}` }));
}

function crumbs(parts) {
  const nav = el('nav', { class: 'crumbs' });
  nav.append(el('a', { href: '#/', text: 'Reports' }));
  for (const part of parts) {
    nav.append(' / ');
    if (part.href) nav.append(el('a', { href: part.href, text: part.label }));
    else nav.append(el('span', { text: part.label }));
  }
  return nav;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function viewTypeList() {
  const { reportTypes } = await fetchJson('/api/reports');
  const nodes = [el('div', { class: 'toolbar' }, [el('h1', { text: 'Report types' })])];
  if (reportTypes.length === 0) {
    nodes.push(el('p', { class: 'muted', text: 'No reports received yet. Reports appear here once IdentityIQ posts them.' }));
  }
  for (const type of reportTypes) {
    const latest = type.files[0];
    nodes.push(
      el('div', { class: 'card' }, [
        el('h2', {}, [el('a', { class: 'item-link', href: `#/type/${encodeURIComponent(type.reportType)}`, text: type.reportType })]),
        el('div', {
          class: 'meta',
          text: latest
            ? `${type.files.length} file(s), latest ${latest.receivedAt} (${formatBytes(latest.bytes)})`
            : 'No files',
        }),
      ]),
    );
  }
  app.replaceChildren(...nodes);
}

async function viewFileList(type) {
  const { reportTypes } = await fetchJson('/api/reports');
  const entry = reportTypes.find((t) => t.reportType === type);
  const nodes = [
    crumbs([{ label: type }]),
    el('div', { class: 'toolbar' }, [el('h1', { text: type })]),
  ];
  if (!entry || entry.files.length === 0) {
    nodes.push(el('p', { class: 'muted', text: 'No files for this report type.' }));
  }
  for (const file of entry ? entry.files : []) {
    nodes.push(
      el('div', { class: 'card' }, [
        el('h2', {}, [
          el('a', {
            class: 'item-link',
            href: `#/view/${encodeURIComponent(type)}/${encodeURIComponent(file.name)}`,
            text: file.name,
          }),
        ]),
        el('div', { class: 'meta', text: `${file.receivedAt} · ${formatBytes(file.bytes)}` }),
      ]),
    );
  }
  app.replaceChildren(...nodes);
}

async function viewDashboard(type, file) {
  const dataUrl = `/api/reports/${encodeURIComponent(type)}/${encodeURIComponent(file)}`;
  const container = el('section');
  app.replaceChildren(
    crumbs([{ label: type, href: `#/type/${encodeURIComponent(type)}` }, { label: file }]),
    el('div', { class: 'toolbar' }, [
      el('h1', { text: `${type} — ${file}` }),
      el('a', { class: 'btn', href: `${dataUrl}?download`, text: 'Download CSV' }),
    ]),
    container,
  );
  const dashboard = dashboardFor(type);
  await dashboard.render(container, { type, file, dataUrl });
}

async function route() {
  const hash = location.hash || '#/';
  const segments = hash.slice(2).split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (segments.length === 0) await viewTypeList();
    else if (segments[0] === 'type' && segments.length === 2) await viewFileList(segments[1]);
    else if (segments[0] === 'view' && segments.length === 3) await viewDashboard(segments[1], segments[2]);
    else location.hash = '#/';
  } catch (err) {
    renderError(err);
  }
}

async function showUser() {
  try {
    const me = await fetchJson('/api/me');
    document.getElementById('current-user').textContent = me.upn;
  } catch (err) {
    document.getElementById('current-user').textContent = 'unknown user';
  }
}

window.addEventListener('hashchange', route);
showUser();
route();

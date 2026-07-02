# IdentityIQ Report → Web App: Rule + Receiver/Dashboard SPA

> **Outcome (2026-07-02):** implemented as planned and delivered on
> [pokkai/claude-code#1](https://github.com/pokkai/claude-code/pull/1).
> One deviation: creating the new private repo `pokkai/identityiq-report`
> was denied by the session's GitHub scoping (403), so the pre-approved
> fallback was used — the project landed as the self-contained
> `identityiq-report/` directory on branch
> `claude/identityiq-report-post-r1rm7u`. All verification steps below
> passed except `docker build` (no Docker daemon in the build environment)
> and the IdentityIQ rule itself (requires an IIQ instance; manual test
> steps are in the project README).

## Context

Two connected deliverables, requirements confirmed through Q&A:

1. **An IdentityIQ rule** that retrieves the results of a report and POSTs the CSV to a URL.
2. **A simple, secure, robust web app** (SPA) that receives those reports, writes them to a directory, and serves a dashboard UI to visualize them. The app will receive *different* reports over time and provide a *different dashboard per report type*. **Dashboard visualizations themselves are implemented separately later** (no sample report data exists yet) — the first one will be the relationship between business roles, IT roles, and entitlements. This plan delivers the app shell with a pluggable dashboard architecture and a generic CSV table view as the default.

### Confirmed decisions

| Area | Decision |
|---|---|
| Rule trigger | Report/task **completion rule**; also works standalone via **latest completed TaskResult by report name** |
| Payload | The report's **CSV** `PersistedFile`, **streamed** (files can exceed 10MB — never buffered fully in memory) |
| Rule HTTP | Raw-body POST, `Content-Type: text/csv`, **Bearer token**, chunked transfer encoding |
| Rule config | URL/token/report name in a `sailpoint.object.Custom` object; token IIQ-encrypted |
| App runtime | **Self-hosted Node.js in a Linux container** (Dockerfile provided); TLS terminated by a **reverse proxy** in front |
| Storage | **Filesystem only** — CSVs written to a data directory, no database |
| Ingest auth | Bearer token (constant-time compare) |
| Viewer auth | **Unverified UPN** — user explicitly accepted the risk: NTLM handshake parsed for the *claimed* `DOMAIN\user`, **no ticket/keytab verification** (spoofable; prominently documented and every claimed UPN logged with source IP). Authorization: **any "authenticated" user**. Non-NTLM clients: **deny (401)** |
| SPA | **No-build vanilla JS** (single `index.html` + JS/CSS served by the Node app, hash routing, zero frontend deps) |
| Delivery | Create **new private repo `pokkai/identityiq-report`**; if repo creation is denied by session GitHub scoping, fall back (user-approved) to branch `claude/identityiq-report-post-r1rm7u` on `pokkai/claude-code` + PR |

## Repo layout

```
identityiq/
  Rule-Report-Result-POST.xml          # TaskCompletion BeanShell rule
  Custom-Report-POST-Configuration.xml # Custom config object (url, token, reportName, timeouts)
webapp/
  package.json                         # dependency: express only (NTLM parse hand-rolled)
  server/
    index.js        # Express bootstrap, security headers, logging
    config.js       # env-driven config (PORT, DATA_DIR, INGEST_TOKEN, MAX_UPLOAD_MB)
    ntlm-ident.js   # NTLM Type1/2/3 middleware — identification only, well-commented risk warning
    ingest.js       # POST /api/ingest — bearer auth, stream body to disk
    reports.js      # GET /api/reports, GET /api/reports/:type/:file
  public/
    index.html, app.js, styles.css     # hash-routed SPA shell
    dashboards/
      registry.js         # maps report type -> dashboard module
      generic-table.js    # default: safe-escaped CSV table preview + download
      role-relationships.js  # documented stub for the business/IT role/entitlement dashboard
  Dockerfile
  docker-compose.yml
  .env.example
README.md
```

## Part 1 — IdentityIQ rule

`Rule-Report-Result-POST.xml`, type `TaskCompletion`, BeanShell:

1. **Resolve TaskResult:** use the `taskResult` argument when invoked as a completion rule; otherwise read `reportName` from the Custom config and query the latest completed `TaskResult` for that definition (ordered by `completed` desc).
2. **Find the CSV:** `taskResult.getReport()` → `JasperResult` → iterate `getFiles()` for content type `text/csv`; clear error if the report lacks "Save Report as CSV".
3. **Config:** `context.getObjectByName(Custom.class, "Report POST Configuration")` → `targetUrl`, `bearerToken` (via `context.decrypt()`), timeouts. Never log the token.
4. **Stream POST:** `PersistedFileInputStream` (reads `FileBucket` chunks; exact package varies by IIQ version — adjust the import if needed) → `java.net.HttpURLConnection`, `setChunkedStreamingMode(8192)`, headers `Authorization: Bearer …`, `Content-Type: text/csv`, and `X-Report-Name` so the app can route by report type. 8KB copy buffer; flat memory use.
5. **Result:** 2xx = success (log status); otherwise log status/response snippet and throw `GeneralException` so the task result shows the failure. Streams closed in `finally`.

`Custom-Report-POST-Configuration.xml`: placeholder entries for `targetUrl`, `bearerToken`, `reportName`, `connectTimeoutMs`, `readTimeoutMs`.

## Part 2 — Web app

**Ingest** — `POST /api/ingest`:
- Bearer token check via `crypto.timingSafeEqual`; 401 otherwise.
- Report type from `X-Report-Name` header (or `?name=`), sanitized (`path.basename`, safe charset) — no traversal.
- Streams the request body straight to `DATA_DIR/<type>/<ISO-timestamp>.csv` (handles >10MB with flat memory); enforces `MAX_UPLOAD_MB`; cleans up partial files on error; 201 with stored filename.

**Viewer API** (NTLM-identification middleware applied):
- `GET /api/me` — claimed UPN.
- `GET /api/reports` — report types + files with size/timestamp metadata (directory scan).
- `GET /api/reports/:type/:file` — streams a CSV (dashboard data source and download), traversal-guarded.

**NTLM identification middleware** (`ntlm-ident.js`, hand-rolled ~100 lines, avoiding an unmaintained dependency):
- 401 + `WWW-Authenticate: NTLM` (the NTLM leg is what carries a readable claimed username; a Kerberos blob is unreadable without a keytab).
- Parses Type 1 → replies static Type 2 challenge → parses Type 3 for claimed `domain\user`; stores UPN-style identity, logs it with source IP on every session start.
- **No cryptographic verification — spoofable by design (risk accepted).** Loud comment block + README warning; recommendation to restrict network reachability stays in the docs.
- Anything that never completes NTLM gets 401 (deny fallback).

**SPA** (no-build vanilla JS):
- Hash routes: `#/` report-type list → `#/type/<name>` file list → `#/view/<type>/<file>` dashboard.
- `dashboards/registry.js` picks the dashboard module by report type; unknown types fall back to `generic-table.js` (escaped, row-limited CSV table + download link). `role-relationships.js` ships as a registered stub with a "visualization pending sample data" panel — the extension point for the later dashboard work.
- Displays the claimed UPN in the header.

**Hardening:** security headers set directly (CSP `default-src 'self'`, `nosniff`, `frame-ancestors 'none'`, etc. — no helmet dependency), request size caps, all rendering escaped, basic rate limiting on ingest failures, structured request logging. Plain HTTP inside the container; README documents reverse-proxy TLS termination (bearer + NTLM headers must not cross untrusted networks in plaintext).

**Container:** `node:22-alpine` Dockerfile (non-root user, `DATA_DIR` volume), compose example with env vars.

## Delivery steps

1. Author all files; `xmllint --noout` the two IIQ XMLs.
2. Verify the web app end-to-end locally (below).
3. Attempt `mcp__github__create_repository` → private `identityiq-report`; push to `main`.
4. If creation is denied by session scoping: commit everything under the designated branch `claude/identityiq-report-post-r1rm7u` of `pokkai/claude-code`, push, open a ready-for-review PR, and explain the fallback.

## Verification

- `npm start` the app; generate a >10MB test CSV; `curl` ingest with the bearer token (expect 201, file on disk, correct size) and with a bad token (expect 401).
- `curl --ntlm -u 'DOMAIN\tester:x'` against `/api/reports` to exercise the NTLM identification path; plain curl gets 401.
- Load the SPA with Chromium (Playwright) to confirm list → file → generic table dashboard render.
- `docker build` the image if the environment permits.
- IIQ rule can't run outside an IdentityIQ instance: README documents the manual test — import XMLs, enable CSV output on the report, attach the completion rule, point `targetUrl` at the app, run the report, confirm the file lands and appears in the dashboard.

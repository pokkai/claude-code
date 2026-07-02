# Web app regression tests (spec-driven) + simplicity review

> **Outcome (2026-07-02):** implemented as planned. The suite (27 tests)
> was written from the 2026-07-02 delivery plan without consulting the
> implementation, then run against it: **all server-level tests passed on
> the first run** — no behavioral gaps were found; the only fix needed was
> test infrastructure (the extracted CSV module had to be `.mjs` because
> the package is CommonJS). Simplicity review removed the unnecessary SPA
> fallback route in `server/index.js` (the SPA is hash-routed, so it was
> unreachable in practice); everything else traced back to a planned
> requirement. Suite green after removal; browser smoke test passed.

## Context

The web app under `identityiq-report/webapp/` was delivered without automated tests. Goals:

1. **A regression test suite**, written TDD-style: derive the tests from the approved plan document (`2026-07-02-report-post-rule-and-dashboard-app.md`) as if the implementation were unknown, then run the implementation against them. Where a test exposes a real gap, fix the *app code*; a test only changes if it contradicts a decision recorded in the plan.
2. **A simplicity review** of the app code: remove functionality that was never asked for; keep the code minimal.

## Test approach

**Framework: Node's built-in `node:test` + `node:assert`** — zero new dependencies, matching the project's no-build/minimal-deps principle. `npm test` runs the suite. No Playwright dependency in the suite; the server's whole contract is HTTP, and the one meaningful piece of frontend logic (the CSV parser) becomes unit-testable via a small extraction.

**Harness (`test/helpers.js`):**
- Boot `server/index.js` as a child process with a temp `DATA_DIR`, a random free port, and a known `INGEST_TOKEN`; wait for it to accept connections; kill after the suite.
- A raw `node:http` client with a dedicated keep-alive agent (`maxSockets: 1`) so requests share one TCP connection — required to test NTLM's connection-bound identity.
- NTLM message builders: craft Type 1 and Type 3 buffers (signature `NTLMSSP\0`, message type, security buffers for domain/user, unicode flag) purely from the protocol layout described in the plan.

**Test files, asserting only planned behavior:**

- `test/ingest.test.js` — bearer auth (401/201), storage under `DATA_DIR/<type>/<timestamp>.csv` byte-identical, `X-Report-Name` and `?name=` routing, hostile-name sanitization, >10MB round-trip, `MAX_UPLOAD_MB` cap (413 + partial cleanup), auth-failure rate limiting (429).
- `test/viewer.test.js` — 401 + `WWW-Authenticate: NTLM` for unauthenticated viewer/SPA access, full Type1→Type2→Type3 handshake, connection-scoped identity, `/api/me` (`upn`, `verified:false`), listing metadata, CSV streaming with `?download` disposition, traversal rejection, malformed-token robustness.
- `test/server.test.js` — unauthenticated `/healthz`, security headers (CSP, nosniff, `X-Frame-Options: DENY`, `no-store`, no `x-powered-by`), refusal to start with missing/short `INGEST_TOKEN`.
- `test/csv-parse.test.js` — RFC 4180 unit tests: quoted fields, escaped quotes, CRLF, embedded commas/newlines, final row without newline, empty input, row-cap truncation flag.

**Enabling refactor:** extract `parseCsv` from `public/dashboards/generic-table.js` into `public/dashboards/csv.mjs` — a pure module with no imports, loadable both by the browser and by Node's test runner (`.mjs` because the package is `"type": "commonjs"`).

## Simplicity review

Audit every file in `webapp/` against the approved plan; remove what wasn't asked for:

- `server/index.js`: **removed** the catch-all SPA fallback route serving `index.html` for unknown non-API paths — the SPA is hash-routed, so deep links never reach the server; `express.static` already serves `/`.
- `server/reports.js`: **kept** the double traversal guard (charset check + resolved-path prefix check) — redundancy is cheap defense on a security path the plan explicitly calls for.
- Everything else (rate limiting, `?download`, security headers, health check, config validation, dashboard registry/stub) traces directly to a planned requirement; no other unrequested surface found.

## Files

- New: `webapp/test/helpers.js`, `webapp/test/ingest.test.js`, `webapp/test/viewer.test.js`, `webapp/test/server.test.js`, `webapp/test/csv-parse.test.js`, `webapp/public/dashboards/csv.mjs`.
- Modified: `webapp/package.json` (`"test": "node --test"`), `webapp/public/dashboards/generic-table.js` (imports `./csv.mjs`), `webapp/server/index.js` (fallback route removed), `README.md` ("Running the tests" section).

## Execution order (TDD posture)

1. Write all tests from the plan document only.
2. Run the suite against the untouched app; record which tests fail and why.
3. Fix app code for genuine gaps; adjust a test only where it contradicts a recorded decision.
4. Apply the simplicity removals; suite must stay green.
5. Re-run the Playwright walk-through ad hoc (not a committed dependency) to confirm the SPA still renders after the refactor.

## Verification

- `cd identityiq-report/webapp && npm test` — 27/27 green.
- Ad-hoc Chromium smoke test of the SPA after the refactor — list, files, stub dashboard with table, generic fallback all render.

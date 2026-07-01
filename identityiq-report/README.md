# IdentityIQ Report → Dashboard

End-to-end pipeline for shipping SailPoint IdentityIQ report results to a
self-hosted dashboard:

1. **`identityiq/`** — a rule that runs when a report completes and streams
   the report's CSV to the web app over HTTPS (Bearer auth, chunked, flat
   memory use even for very large files).
2. **`webapp/`** — a containerized Node.js app that receives the CSVs,
   stores them on disk, and serves a no-build single-page dashboard UI.
   Each report type can have its own visualization; unknown types get a
   generic table view. The first specific dashboard (business roles ↔ IT
   roles ↔ entitlements) is a registered stub awaiting sample data.

```
IdentityIQ report completes
  └─ Rule "Report Result POST"  ──POST /api/ingest (Bearer)──►  webapp
                                                                 ├─ /data/<Report Name>/<timestamp>.csv
                                                                 └─ SPA dashboards (NTLM identification)
```

---

## ⚠️ Security model — read this first

| Surface | Protection |
|---|---|
| `POST /api/ingest` | Bearer token (constant-time compare, rate-limited failures) |
| Dashboard + viewer API | **NTLM identification only — the claimed identity is NOT verified** |
| Transport | Plain HTTP in the container; **a TLS-terminating reverse proxy in front is required** |

**The viewer side is identification, not authentication.** The app completes
an NTLM handshake purely to read the username/domain the client *claims*;
there is no keytab and no domain-controller validation, so anyone who can
reach the app can claim any identity (`curl --ntlm -u 'CORP\anyone:x' …`).
This trade-off was an explicit deployment decision to get an SSO feel for
domain-joined browsers without Kerberos infrastructure. Consequences:

- **Restrict network reachability** to the app (firewall / internal segment /
  proxy allowlist). The network layer is the real access control.
- Every claimed identity is logged with its source IP (`[ntlm-ident] …`).
- If you later need real authentication, replace `webapp/server/ntlm-ident.js`
  with keytab-based SPNEGO, LDAP-bind login, or OIDC.

Also: the Bearer token and NTLM headers cross the wire on every request —
never expose the app without TLS in front.

---

## Part 1 — IdentityIQ setup

### Import the objects

```text
iiq console
> import identityiq/Custom-Report-POST-Configuration.xml
> import identityiq/Rule-Report-Result-POST.xml
```

(or paste them into the Debug page.)

### Configure

Edit the `Report POST Configuration` Custom object (Debug page):

| Key | Value |
|---|---|
| `targetUrl` | `https://<your-host>/api/ingest` |
| `bearerToken` | the ingest token, **IIQ-encrypted**: run `iiq encrypt <token>` and paste the output |
| `reportName` | report TaskDefinition name — only used when the rule runs standalone |
| `connectTimeoutMs` / `readTimeoutMs` | HTTP timeouts (defaults 30 s / 300 s) |

### Wire it to the report

1. Open the report and enable **Save Report as CSV** (Standard Properties) —
   the rule reads that CSV artifact.
2. Attach the rule as the report task's completion rule. The report editor
   doesn't expose this, so set it on the TaskDefinition via the Debug page:

   ```xml
   <TaskDefinition ...>
     ...
     <RuleRef>
       <Reference class="sailpoint.object.Rule" name="Report Result POST"/>
     </RuleRef>
   </TaskDefinition>
   ```

   (In IIQ the `RuleRef` element on a TaskDefinition is the completion rule.
   If your version models it as an attribute instead, set
   `taskCompletionRule` accordingly.)
3. Run the report. On completion the rule streams the CSV; the outcome is
   logged under the `rule.ReportResultPOST` log4j category and surfaced on
   the task result if it fails.

Standalone alternative: create a generic **Run Rule** task pointing at
`Report Result POST` — with no `taskResult` argument the rule posts the
latest completed result of the configured `reportName`.

The rule sends the report definition name in an `X-Report-Name` header;
the web app uses it to group files and pick the dashboard.

> Note: the rule imports `sailpoint.persistence.PersistedFileInputStream`
> to stream the stored CSV. If your IIQ version packages that class
> elsewhere (e.g. `sailpoint.api`), adjust the single import line.

## Part 2 — Web app

### Run

```bash
cd webapp
cp .env.example .env        # set INGEST_TOKEN (e.g. openssl rand -hex 32)
docker compose up -d --build
```

or without Docker: `INGEST_TOKEN=... node server/index.js` (Node ≥ 18, then
`npm install` first).

Put your TLS reverse proxy in front of port 8080 and give IdentityIQ the
proxy's HTTPS URL as `targetUrl`.

### Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/ingest` | Bearer | Receive a CSV (`X-Report-Name` header names the report type) |
| `GET /api/reports` | NTLM ident | List report types and files |
| `GET /api/reports/:type/:file` | NTLM ident | Stream a CSV (`?download` for attachment) |
| `GET /api/me` | NTLM ident | Claimed identity |
| `GET /healthz` | none | Container health check |
| `GET /` | NTLM ident | The SPA |

Environment variables: see `webapp/.env.example`.

### Browser note for the SSO feel

Browsers only auto-answer NTLM for trusted sites: add the app's URL to the
Windows intranet zone (or the `AuthServerAllowlist` policy for
Chrome/Edge, `network.automatic-ntlm-auth.trusted-uris` for Firefox).
Anything that doesn't complete the handshake gets a 401 — that's the
intended "deny" fallback.

### Adding a dashboard for a new report

Dashboards are plain ES modules — no build step:

1. Create `webapp/public/dashboards/<name>.js` exporting
   `render(container, ctx)`; fetch `ctx.dataUrl` for the CSV
   (`parseCsv` in `generic-table.js` is reusable).
2. Register it in `webapp/public/dashboards/registry.js` under the exact
   report type name (the sanitized report name shown in the UI).

Unregistered types automatically get the generic table view.
`role-relationships.js` is the prepared stub for the business role / IT
role / entitlement report.

## Manual end-to-end test

```bash
# 1. Simulate IdentityIQ posting a report:
curl -sS -X POST "https://<host>/api/ingest" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: text/csv" \
  -H "X-Report-Name: Role Relationships" \
  --data-binary @sample.csv
# → {"reportType":"Role Relationships","file":"...csv","bytes":...}

# 2. Viewer API with a claimed identity:
curl -sS --ntlm -u 'CORP\tester:x' https://<host>/api/reports

# 3. Open https://<host>/ in a domain browser — the report should be listed.
```

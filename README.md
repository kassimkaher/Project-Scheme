# QA Orchestrator

This repository also contains **Project Scheme**, an additive bootstrap layer for creating project-local AI context and optional QA integration without copying the QA engine. Start at [START-HERE.md](START-HERE.md).

A self-hosted AI QA control room for web applications and APIs.

It is designed around one simple workflow:

`System Spec -> AI Discovery -> Use Cases -> Browser/API QA -> Evidence -> Report -> Developer Fix -> Re-run`

The first release focuses on **Web + API**. Mobile is intentionally left as a later adapter.

## It is generic

The orchestrator ships with **no project**. No customer, account, URL or test
case is built into it. A fresh install shows an empty library and offers three
ways in: import a QA definition, build one with the wizard, or download the
example template. The bundled example is a placeholder using `example.com`, it is
never auto-imported, and it never appears as an active project.

## What it does

**Project library**
- Imports a portable `qa-system.md` (or JSON) describing environments, API and
  OpenAPI URLs, web applications, QA accounts or a live persona catalog, and the
  test-safety policy.
- Keeps every imported definition as a saved project, so you never re-upload a
  file to run QA again.
- Per project: environment / account / web-app counts, run count, last run and
  its result; Open, Re-run, Edit, Import updated definition, Duplicate, Delete,
  and full run history.
- Re-importing a known definition never silently duplicates it: you are asked to
  update the existing project, import as a new copy, or cancel.
- Editing configuration in place — system name, environments, API and OpenAPI
  URLs, web apps, account metadata. Credential values are never shown or
  editable in the UI; they change only by importing an updated definition.
- Encrypts credentials at rest with AES-256-GCM, stored separately from the
  listable metadata.

**QA accounts**
- Static accounts from the definition, **or** a live persona catalog URL that is
  re-fetched at the start of every run.
- The catalog reader is generic: it detects common field names for id, role,
  identifier, password and TOTP in any JSON shape. No system's persona ids are
  encoded in the product.
- A run fails preflight, with the missing names listed, if the catalog no longer
  publishes a persona or role the definition requires.

**Running**
- Four modes: Analyze only, API QA, Browser QA, Full QA.
- Optional scope: restrict a run to chosen roles, personas, features or
  individual use case ids from a previous run's generated suite.
- Preflight before every run: Claude Code CLI, session start, tool permissions,
  environment, output directory, API and OpenAPI reachability, web app
  reachability, persona catalog, Playwright MCP, Chromium build. A missing
  required dependency fails the run *before* it costs anything, and every failing
  check carries a concrete fix.
- Each run launches an **independent Claude Code process** with its own isolated
  browser profile, evidence directory and process group.
- One active run per project is enforced so two sessions cannot mutate the same
  QA data at once.

**Watching and controlling a run**
- Explicit stages: preparing, preflight, reading configuration, fetching
  OpenAPI, resolving accounts, starting Claude Code, system analysis, use-case
  generation, starting browser, API testing, web testing, collecting evidence,
  writing report.
- Live stage, elapsed time, active use case, pass/fail/blocked/evidence counts,
  and a redacted live log.
- **Stop/Cancel** kills the run's whole process tree — supervisor, Claude Code,
  the MCP server and the browser — and no other run. Logs and evidence produced
  so far are preserved.
- **Retry** always creates a new run; the original failure stays in history.
- **Clear** hides a finished run from the active list and deletes nothing.
  Deleting report, logs and evidence is a separate, confirmed action.
- There is deliberately no pause: see Current limitations.

**When a run fails**
- The reason is on screen immediately: failing stage, human-readable message,
  what to fix, exit code, signal, timestamp, and which startup gates were
  observed to pass (Claude started, browser connected, OpenAPI reachable,
  accounts resolved).
- A collapsible panel holds redacted stdout and stderr tails, with copy-error and
  download-full-log actions. You never have to open a file to learn why a run
  failed.

**Results**
- Report, structured results, generated use cases, system analysis, stage
  timeline, live log, preflight record, evidence gallery, artifact downloads.
- **Compare with a previous run**: newly failing, fixed, still failing, new
  issues, resolved issues, and pass/fail/blocked deltas.

## Important architecture choice

The QA agent and the coding agent should be separate.

This application does **not** ask the QA agent to modify the tested product. Its prompt explicitly makes it a tester only. The intended loop is:

1. Development agent implements a feature.
2. QA Orchestrator runs an independent QA session.
3. QA report contains reproducible defects + evidence.
4. Give the report to the development agent.
5. Development agent fixes defects.
6. Re-run QA.
7. Human owner performs the final review.

That separation makes the QA result more useful than letting the same coding session be the only judge of its own work.

## Requirements

- Node.js 20+
- npm
- Claude Code installed locally and already authenticated
- Network access from this machine to the system you are testing

`@playwright/mcp` and a Chromium build are installed locally as project
dependencies, so a QA run needs no network access to a package registry.

## Quick start

```bash
cp .env.example .env.local
openssl rand -base64 32        # put this in QA_MASTER_KEY in .env.local

npm install
npm run qa:browsers            # one-time Chromium download for browser QA
npm run qa:doctor              # verifies every dependency a run needs
npm run dev
```

Open <http://127.0.0.1:4100>. The library starts empty — nothing is preloaded.

## Claude Code setup

No global MCP configuration is required. Every run writes its own
`.mcp.json` pointing at the locally installed Playwright MCP with an isolated
browser profile and a run-scoped evidence directory, and the session is started
with `--strict-mcp-config` so a broken server in your global Claude Code
configuration cannot affect a run.

The session is started as:

```text
claude -p --output-format stream-json --verbose \
       --mcp-config ./.mcp.json --strict-mcp-config \
       --permission-mode bypassPermissions
```

`--permission-mode` is not optional. In non-interactive mode nothing can answer a
permission prompt, so a session without it has every tool call denied and
produces no report.

`CLAUDE_ARGS` is **merged into** those defaults rather than replacing them, and a
permission mode is always enforced. Set `CLAUDE_ARGS_REPLACE=1` only if you
genuinely need to supply the whole argument list yourself.

The prompt file carries QA credentials, is written `0600`, and is deleted by the
supervisor the moment it is read. Imported credentials stay encrypted at rest.

## First use

### Option A — download the example

Use **Download example** on the home screen and edit it.

### Option B — onboarding wizard

Open:

```text
http://127.0.0.1:4100/wizard
```

Enter:
- system name
- API base URL
- OpenAPI URL
- web URL
- QA accounts

It generates the portable Markdown spec for you.

### Option C — ask another AI to generate the spec

Give `templates/qa-system.example.md` to an AI together with your project documentation and ask it to produce a filled `qa-system.md` using the exact same structure.

## Spec format

The Markdown file contains a fenced `qa-config` YAML block.

Example:

~~~md
# My System

```qa-config
version: 1

# Optional but recommended: a stable id means re-importing this file always
# updates the same project instead of matching it by name and URLs.
projectId: "my-platform"

system:
  name: "My Platform"
environments:
  - id: "qa"
    label: "QA"
    kind: "qa"
    apiBaseUrl: "https://api.example.com"
    openapiUrl: "https://api.example.com/openapi.yaml"
    webApps:
      - id: "dashboard"
        label: "Dashboard"
        url: "https://app.example.com"

    # Optional: resolve QA personas from a live endpoint at the start of every
    # run, instead of freezing credentials into this file.
    accountCatalog:
      url: "https://api.example.com/qa/accounts.json"
      requiredRoles: ["admin", "member"]

accounts:
  - id: "admin-qa"
    role: "admin"
    loginType: "email_password"
    credentials:
      identifier: "qa@example.com"
      password: "replace-me"
```
~~~

`templates/qa-system.example.md` is the annotated version of this, served by
**Download example**.

## Development

```bash
npm run typecheck
npm run build
npm run qa:selftest     # needs a server running; see the script header
npm run qa:reset        # archive local projects to get back to a clean library
```

`fixtures/` holds definitions used to exercise the orchestrator during
development. They are not part of the product and are never served to users.

## Generated run artifacts

Every run receives its own folder under
`.qa-data/projects/<project-id>/runs/<run-id>/`.

Expected outputs from the QA agent:

```text
run.json                  status, stage, counts, structured failure
agent.log                 human-readable, secrets redacted
agent-stream.ndjson       Claude Code event stream (redacted)
progress.ndjson           stage timeline appended by the agent
system-analysis.json
use-cases.json
results.json
report.md
accounts-resolved.json    personas used (field names only, no values)
evidence/
  screenshot-*.png
```

### `system-analysis.json`

The agent records:
- roles
- web apps
- API summary
- feature tree
- authentication flows
- architecture observations
- testing risks

### `use-cases.json`

The generated scenarios should cover:
- successful paths
- validation failures
- authorization
- role/tenant separation
- state transitions
- cross-role flows
- persistence after refresh
- loading/empty/error behavior
- visual/responsive checks

### `report.md`

Every confirmed browser issue must have evidence. The prompt requires:
- severity
- account/role
- exact reproduction steps
- expected result
- actual result
- screenshot/evidence path
- safe request/response summary when relevant

## Example of the QA model we want

For an assignment feature, the QA agent should not only test “Create assignment”. It should reason through the complete use case:

1. Teacher logs in.
2. Teacher selects a real course.
3. Teacher creates and publishes an assignment.
4. Student logs in.
5. Student sees the assignment.
6. Student submits it.
7. Teacher logs in again.
8. Teacher sees the submission.
9. Teacher grades/releases it.
10. Refresh/re-login verifies persistence.
11. Permission tests verify unrelated students/teachers cannot access it.
12. Visual review verifies no clipping, oversized components or broken responsive layout.

This is why discovery and use-case generation happen before execution.

## Production safety / protection

This project is intentionally bound to `127.0.0.1` by default.

**Do not expose it directly to the public internet**, because it can contain QA credentials and can launch an AI/browser process.

Recommended remote access:
- SSH tunnel
- Tailscale / private VPN
- authenticated reverse proxy on a private network

Other safeguards included:
- QA credentials encrypted at rest
- credentials masked in the UI
- tester prompt forbids printing passwords/tokens/cookies in reports
- production runs are instructed not to delete real records, mass-modify data, brute force authentication, stress test, or execute exploit payloads
- separate run directories and isolated browser contexts

For a multi-user production service, the next hardening phase should add:
- real user authentication
- PostgreSQL
- Redis/job queue
- role-based access to projects/runs
- secret manager integration
- audit log
- worker isolation/containers
- per-project network allowlists
- run cancellation/time/resource quotas

## Why Playwright MCP

Playwright MCP lets Claude Code interact with real pages through the browser and structured page accessibility data. It supports navigation, clicking, filling forms, screenshots, browser profiles, and a standalone server mode.

For this project we use an isolated browser per run to reduce state leakage between QA sessions.

## Why Claude Code / Agent architecture

The orchestrator deliberately gives the AI:
- the system definition
- the live OpenAPI URL
- the web URL
- role-aware QA accounts
- explicit testing policy

It then asks the model to discover missing scenarios rather than forcing the human owner to manually author every test case.

Humans can still add explicit business notes in the Markdown spec when a behavior is not discoverable from the UI/API.

## Current limitations

- API execution is agent-driven rather than a separate deterministic HTTP engine.
  A later version can add a request recorder / assertion runner for stronger
  repeatability.
- Reports are displayed as plain Markdown text rather than rendered.
- There is no true pause. Freezing a live browser session and an authenticated
  session produces results you cannot trust, so the product offers Stop/Cancel
  plus Retry instead of pretending to pause.
- Run comparison matches cases by id, so it is only as good as the agent's id
  stability. The prompt pins the schema and asks for stable ids; drift shows up
  as "new" and "resolved" rather than "fixed".
- Single local user. There is no authentication, no RBAC and no audit log; see
  the hardening list above before running this for a team.
- **The QA agent runs with your permissions.** A non-interactive session must not
  be promptable, so it is started with `bypassPermissions` and can run anything
  your user can. The prompt confines it to its run directory, but that is
  guidance to a model, not a sandbox. Keep your QA definitions in source control,
  and read the trust-boundary section of SECURITY.md before pointing this at
  anything important.
- Mobile testing is not included yet.

These are deliberate boundaries. The Web/API AI-QA loop is represented end to
end: import, discovery, use-case generation, execution, evidence, report,
re-run and comparison.
# Project-Scheme

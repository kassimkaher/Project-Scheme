# Architecture

## Shape

```
Project library  ──▶  Selected project  ──▶  Run QA  ──▶  Current run  ──▶  Results
   (import,             (definition,          (env, mode,     (stages,        (report,
    wizard,              environments,         scope)          cancel,         issues,
    example)             personas, history)                    live log)       evidence,
                                                                               compare)
```

The orchestrator is generic. It contains no project, customer, account, URL or
test case of its own. Everything it knows comes from a QA definition the user
imports deliberately.

## Separation of concerns

The QA agent and the coding agent are separate processes with separate jobs. The
QA agent is told, in its prompt, that it does not edit the tested product. The
intended loop is: build → QA run → report with reproducible defects and evidence
→ development agent fixes → re-run → human review.

## Storage (`.qa-data`, schema v3)

```
.qa-data/
  meta.json                     schema version + migration notes
  projects.index.json           non-secret integrity index; detects missing projects
  projects/<project-id>/
    project.json                non-sensitive metadata, definition WITHOUT credential values
    secrets.enc                 AES-256-GCM: credential values only
    source.enc                  AES-256-GCM: the original imported text
    runs/<run-id>/
      run.json                  status, stage, counts, bounded structured failure
      prompt.txt                written 0600, deleted by the supervisor on read
      .mcp.json                 this run's isolated browser
      agent.log                 human-readable, redacted
      agent-stream.ndjson       Claude Code event stream (redacted)
      progress.ndjson           stage timeline appended by the agent
      system-analysis.json  use-cases.json  results.json  report.md
      accounts-resolved.json    which personas this run used (no secret values)
      evidence/
  orphan-runs/                  runs whose project no longer exists; never deleted
```

Two properties are load-bearing:

- **`project.json` holds no secret material.** Credential *field names* are kept
  so the UI can show what exists; the values live only in `secrets.enc`. This is
  why the library can be listed, searched and edited without ever decrypting.
- **Run statistics are derived from the run.json files on disk**, not read from a
  stored counter. A cached count drifts after a crash, a manual deletion or a
  layout migration, and a project library that under-reports its own history is
  worse than a marginally slower one.

Migration from the v1 layout runs once, on first access. It preserves every
project and artifact, re-homes global runs under their project, keeps runs whose
project is gone in `orphan-runs/`, and marks a run that was left mid-flight as
failed rather than leaving a phantom "running". It never marks a project active.

## Configuration vs live sources

The saved definition is *configuration*. The OpenAPI document and the QA account
catalog are *live sources*, re-read at the start of every run. A re-run therefore
never tests against a stale contract or a retired persona.

## Run lifecycle

The API route owns preparation, because it can reuse the typed library and can
answer the user synchronously: read config → resolve personas from the live
catalog → preflight → write the run-local MCP config and prompt → spawn.

`scripts/run-agent.mjs` owns supervision only, and is dependency-free so it
cannot fail to start over a module boundary. It is spawned **detached**, making it
the leader of a new process group; Claude Code, the Playwright MCP server and the
browser all inherit that group. Cancelling signals the negative pgid, which stops
the whole tree instead of orphaning children behind a dead parent — and touches
no other run.

Stages come from two places: the orchestrator reports the ones it performs
itself, and the agent appends its own to `progress.ndjson`, which the supervisor
tails. A failure is stored as a bounded, redacted object — stage, message, exit
code, signal, stdout/stderr tails, and which startup gates were observed to pass.
Full logs stay in files; `run.json` stays small.

Both log writers redact *inside the writer*, not at the call site. That is a
correction, not a preference: the event stream was originally written verbatim,
and a real web run leaked 26 lines of persona passwords into a file the app
serves. On top of that, `finish()` sweeps the run directory for any resolved
secret before writing the terminal state, because the agent itself once wrote a
`qa-accounts-live.json` full of live credentials despite the prompt forbidding
it. Only files that actually contain a secret are rewritten.

## Isolation

Per project: definition, secrets, run history, reports, evidence.
Per run: directory, MCP config, browser profile (`--isolated`), evidence dir,
process group. `--strict-mcp-config` means a broken MCP server in the operator's
global configuration cannot poison a run.

One active run per project is enforced, so two sessions cannot mutate the same QA
data at once. Runs across different projects may proceed in parallel up to
`QA_MAX_CONCURRENT_RUNS`.

## Security

AES-256-GCM at rest, keyed by `QA_MASTER_KEY`. Credential values are never
returned by any endpoint and never rendered. Log output, error messages and
failure records pass through a redactor that scrubs authorization headers,
cookies, JWTs, private keys, secret-looking key/value pairs and the specific
credential values resolved for that run. The agent's prompt forbids writing
credentials into any artifact. Deleting a project removes its secrets and every
run artifact it owned.

Bound to `127.0.0.1` by default. It holds QA credentials and can launch a browser
process, so it must not be exposed directly to the internet.

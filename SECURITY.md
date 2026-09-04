# Security

This is a **local, single-user** tool. It holds QA credentials and can launch a
browser and an AI process, so treat it as sensitive infrastructure.

## Network exposure

Bound to `127.0.0.1` by default. **Do not expose it to the internet.** For remote
access use an SSH tunnel, a private VPN such as Tailscale, or an authenticated
reverse proxy on a private network.

## Secrets at rest

- Credential values are encrypted with AES-256-GCM under `QA_MASTER_KEY`
  (32-byte base64 or hex; anything else is hashed to 32 bytes).
- They are stored in `secrets.enc`, mode `0600`, separate from the listable
  project metadata. `project.json` holds credential *field names* only, so the
  library can be listed, searched and edited without decrypting anything.
- `source.enc` holds the original imported text, which may contain credentials,
  and is encrypted for the same reason.
- Generate a key with `openssl rand -base64 32`. Losing it makes existing
  projects unreadable; migration detects this and leaves those files untouched
  rather than destroying them.

## Secrets in transit to the agent

The QA agent needs real credentials to log in. They are written to
`prompt.txt` with mode `0600` and the supervisor deletes that file the moment it
reads it. The credentials never appear in `run.json`, in any API response, or in
the UI.

## Redaction

Everything that can reach a log file, a run record or the screen passes through
`lib/redact.ts`, which scrubs:

- `Authorization` / `Proxy-Authorization` headers, `Bearer` and `Basic` tokens
- `Cookie` / `Set-Cookie` values
- key/value pairs named like `password`, `secret`, `token`, `api_key`,
  `client_secret`, `totp`, `otp`, `mfa_code`
- JWTs, long hex blobs, PEM private key blocks
- the specific credential values resolved for that run, passed to the supervisor
  in a `0600` file that is deleted on read

`stdout` / `stderr` are stored as bounded tails, redacted, so `run.json` cannot
grow without limit or become a secret store.

Redaction happens **inside the log writers**, so a call site cannot forget it.
This is a fix for a real defect: the Claude Code event stream was originally
written verbatim, and a web run put 26 lines containing persona passwords into
`agent-stream.ndjson` — a file served by
`/api/runs/[id]/artifact/agent-stream.ndjson`. `npm run qa:redaction` now
statically asserts that every log write passes through the redactor.

### End-of-run sweep

The prompt forbids the agent from persisting credentials, but the agent is a
model and one run wrote its own `qa-accounts-live.json` containing live
passwords. So when a run reaches any terminal state the supervisor sweeps its
directory — including `evidence/` — and redacts any text artifact containing a
credential resolved for that run. Files without a secret are left byte-identical.
This is a backstop for artifacts the *agent* creates; everything the
orchestrator writes is already redacted at the writer.

## What the agent is told

The prompt forbids writing passwords, TOTP codes, tokens, cookies, authorization
headers, private keys or full sensitive request bodies into any artifact, and
requires accounts to be referenced by id and role only.

## Trust boundary: the QA agent runs as you

This is the most important thing to understand before running this tool.

The QA session is launched with `--permission-mode bypassPermissions`, because a
non-interactive session that can be prompted is a session that hangs. That means
the agent can run any command your user account can run. Its working directory is
the run directory, and the prompt now forbids reading or writing outside it — but
a prompt is guidance to a model, not a sandbox.

Observed in practice: a QA session ran `ls -la ../..` and `cat ../../project.json`
to "understand the setup" before the confinement rule was added. It stayed
read-only and inside the data directory, but nothing technically stopped it going
further.

Consequences to accept, or mitigate yourself:

- Do not run this on a machine holding data you cannot afford to lose or expose.
- Keep your QA definitions in source control. They are the only thing that can
  reconstruct a project; run history cannot be recovered.
- `.qa-data` is a plain directory tree owned by your user. A misbehaving agent,
  an errant script, or a mistaken command can remove a project. The store keeps
  `projects.index.json` so the library *reports* a project whose data has gone
  missing instead of quietly listing fewer projects — but reporting is not
  recovery.
- For stronger isolation, run the orchestrator in a container or a dedicated
  user account with access only to what a QA run legitimately needs.

## Run isolation

Each run gets its own directory, MCP configuration, browser profile
(`--isolated`, nothing inherited), evidence directory and process group.
`--strict-mcp-config` prevents a server in the operator's global Claude Code
configuration from being reachable inside a run. Cancelling signals only that
run's process group.

One active run per project is enforced so two sessions cannot mutate the same QA
data simultaneously.

## Destructive-action policy

`qa.destructiveActions` (`forbid` / `allow-build-test-only` / `allow`) is passed
to the agent. For an environment with `kind: production` the prompt additionally
forbids deleting real records, mass-modifying data, brute-forcing authentication,
stress testing and exploit payloads, and directs the agent toward read-only or
clearly QA-scoped records. The run screen warns before starting a production run.

## Deletion

Deleting a project removes its definition, its encrypted secrets and every run
artifact it owned, after an explicit confirmation that states what will be lost.
"Clear" on a run is a separate, non-destructive action that only hides it from
the active list. A run whose owning project no longer exists is preserved under
`orphan-runs/` rather than deleted silently.

## Not included

There is no user authentication, no role-based access control, no audit log and
no secret-manager integration. Before running this for a team, add: real
authentication, PostgreSQL, a job queue, per-project access control, secret
manager integration, an audit log, worker isolation, per-project network
allowlists, and run time/resource quotas.

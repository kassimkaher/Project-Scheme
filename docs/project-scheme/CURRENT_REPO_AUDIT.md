# Current repository audit

Audited baseline: `07289c1889216909029735741002c0906a2b970c` on `main`.

## QA Orchestrator

The working product is a generic local Next.js QA dashboard. It imports portable definitions, encrypts credentials, resolves live persona catalogs, runs independent Claude Code sessions for API/browser QA, retains evidence and reports, compares runs, retries failures, cancels process trees, and clears runs without deleting their artifacts.

The store implementation in `lib/store.ts` is schema v3. It uses `projects.index.json` to expose missing project directories, random-suffixed atomic writes, and an in-process serialized index read/modify/write path. Root `ARCHITECTURE.md` incorrectly described schema v2 and must be corrected.

## Risks and limits

The running agent uses `bypassPermissions`. Prompt confinement and a run-scoped working directory are not a sandbox. The local store detects missing project data but does not recover run history. The existing self-test uses a live local server and its Claude preflight probe can be affected by account availability or usage limits.

## Migration decision

The application remains at the repository root in this version. Moving `app/`, `lib/`, and package tooling under `apps/qa-orchestrator/` would destabilize Next.js aliases, scripts, deployment, and local data semantics without adding product value. Root README and `START-HERE.md` identify the QA application clearly; Project Scheme lives in `scheme/`, and canonical system documentation lives under `docs/`.

## Baseline gates

The supported regression commands are `npm run typecheck`, `npm run build`, `npm run qa:selftest`, `npm run qa:redaction`, and `npm run qa:doctor`. The implementation branch reruns these after changes.

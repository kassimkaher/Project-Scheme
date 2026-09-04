# QA Orchestrator handover

## Ownership

QA Orchestrator owns the standalone dashboard, project library, encrypted QA credentials, run lifecycle, browser/API execution, evidence, reports, comparison, security, and QA storage. Project Scheme owns bootstrap, project profiles, skill selection, project-local `.ai` state, capability modeling, and the portable `.qa` integration contract.

## Current implementation

The QA runtime is unchanged by the Project Scheme foundation. `lib/store.ts` contains the local store and integrity behavior; local repository history identifies the current hardening commit as `07289c1`. The local implementation, not older remote documentation, is authoritative.

Current safeguards verified before this change: encrypted credentials at rest, log and event-stream redaction, end-of-run secret sweep, process-group cancellation, browser-profile isolation, no real agent launch from self-tests, storage-integrity detection, atomic-write protection, structured failures, and localhost-default development binding.

## Incident context

The prior loss of two `.qa-data` project directories was not proven to a single cause. Its observed shape resembled the project-deletion path. Preserve this uncertainty and do not weaken integrity checks, isolation, or deletion safeguards.

## Tests and limitations

Baseline verification passed: `npm run typecheck`, `npm run qa:redaction`, and `npm run qa:doctor`; doctor reported only a non-blocking npm-cache ownership advisory. Full integration self-test requires a running local server. The QA invocation CLI described in Project Scheme documentation is future-facing and is deliberately not implemented as a fake adapter.

## Project Scheme integration

`scheme/scripts/bootstrap.mjs` produces project-local `CLAUDE.md`, `.ai/`, and optional `.qa/qa-system.md`. The QA definition is portable and contains empty URL/account placeholders; it never embeds credentials. A coding agent can use that definition to prepare a dashboard import and request independent focused QA, while QA Orchestrator remains standalone.

# Final implementation report

## V2 update

Baseline branch and HEAD: `project-scheme/codex-system-v1` at `f15e555b11e9ec6a4bfc86f5adbed829855d2fc0`. V2 uses successor branch `project-scheme/v2-closure` to preserve a reviewable V1 baseline.

V2 makes the control plane versioned (`control_plane_version: 2`), normalizes and validates project state through the canonical JSON Schema, preserves all bootstrap input rather than dropping risk and product attributes, records deterministic explainable profile recommendations, and adds non-destructive v1 migration. Existing-project discovery inspects manifests and common platform/configuration markers through `--existing` without changing source.

Every Skill now has strict `name`/`description` frontmatter and a structural validator. The QA CLI can wait for terminal status and emit machine-readable result metadata with automation exit semantics. The isolation red-team pass created a macOS `sandbox-exec` kernel-boundary probe; it proves a configured unrelated path is denied but also proved that a usable least-privilege Claude/browser profile remains unfinished.

V2 evidence: skill validator passed for 10 Skills; five bootstrap scenario/idempotence checks passed; QA API start/wait test passed; typecheck passed; macOS sandbox probe passed. V1’s previously verified build, redaction, doctor, backup, dogfood, and 114/0 live QA self-test remain part of the baseline.

First-project procedure: [FIRST-PROJECT-BOOTSTRAP.md](FIRST-PROJECT-BOOTSTRAP.md). Red-team evidence: [RED_TEAM_REPORT.md](RED_TEAM_REPORT.md).

## Identity

- Baseline HEAD: `07289c1889216909029735741002c0906a2b970c`
- Implementation branch: `project-scheme/codex-system-v1`
- Final HEAD: this report commit; verify with `git rev-parse HEAD`

## Delivered system

The repository keeps QA Orchestrator working at the root as a staged-compatible layout and adds Project Scheme in `scheme/`. It provides a validated profile input model, deterministic small/production/enterprise selection, reusable platform Skills, local `.ai/` and optional `.qa/` generation, rerun-safe bootstrap behavior, and canonical documentation under `docs/project-scheme/`.

The Skill inventory is project-bootstrap, backend-api, database-engineering, web-application, flutter-mobile, android-native, ios-native, security-baseline, qa-integration, and release-readiness. Generated projects retain only local control files and selected skill names.

## QA and safety

Standalone QA is unchanged. Schema v3 is documented: the store uses `projects.index.json`, random-suffixed atomic writes, serialized in-process index updates, encrypted credentials, stream redaction, terminal artifact secret sweeps, and process-tree cancellation. `npm run qa:run` is the supported agent-driven QA interface; it uses QA HTTP API routes rather than dashboard scraping.

The current isolation mode is explicitly `unsafe-local` in system status, run metadata, CLI output, and documentation. It is not sandboxed. A restricted worker identity or container runner with minimal mounts and network allowlists remains **OPEN**.

`npm run qa:backup -- --output <absolute-directory>` creates a non-overwriting copy of the local store outside its active data directory. Existing self-tests cover safe clear/delete behavior, run preservation, index integrity, concurrent behavior, and stray-process checks.

## Evidence

- `npm run scheme:test`: passed, including small, production Flutter, enterprise multi-platform, Android-only, iOS-only, irrelevant-skill, and rerun-preservation checks.
- `npm run qa:run:test`: passed; verifies import/update and scoped run creation through the supported API contract.
- `npm run typecheck`, `npm run build`, `npm run qa:redaction`, `npm run qa:doctor`, and the live `npm run qa:selftest`: passed. The self-test reported 114 passing checks and zero failures.
- Dogfood: a disposable generic production Flutter project generated `.ai/` and `.qa/`, retained state across a bootstrap rerun, and used the tested focused-QA handoff contract.

## Limitations and follow-up

No real target system or credentials were used for dogfood. Cross-platform OS-level isolation, backup restore verification, and a fully self-contained offline QA-run fixture remain future work.

## Verdict

PROJECT SCHEME V2: NOT CLOSED

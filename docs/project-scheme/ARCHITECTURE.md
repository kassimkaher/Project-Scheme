# Project Scheme architecture

The root application is the standalone QA Orchestrator. `scheme/` is additive: it selects profiles and Skills, generates project-local context, and produces a portable QA definition. Generated projects retain only `CLAUDE.md`, `.ai/`, and optional `.qa/`; they never copy this repository or run the QA engine locally.

The QA store is schema v3: `projects.index.json` makes missing project directories visible, atomic writes use random temporary suffixes, and index updates are serialized inside the process. Agent streams are redacted at write time and terminal runs sweep artifacts for resolved secrets. Prompt confinement is not an OS sandbox; `unsafe-local` is the current execution mode.

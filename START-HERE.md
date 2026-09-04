# Project Scheme and QA Orchestrator

This repository has two separate products.

- **QA Orchestrator** is the standalone dashboard and QA engine. Start it with `npm run dev`; see [README.md](README.md).
- **Project Scheme** is the reusable bootstrap layer in `scheme/`. It gives a new project a small, durable AI context and a link to independent QA.

To bootstrap a project, answer the compact questionnaire in `scheme/bootstrap/questionnaire.md`, save the answers as YAML or JSON, and run:

```bash
npm run scheme:bootstrap -- --answers /path/to/answers.yaml --output /path/to/new-project
```

The generated project receives `CLAUDE.md`, `.ai/`, and, when QA is enabled, `.qa/`. It does not receive a copy of this repository, the skills, or the QA engine. Start future coding sessions by following that generated `CLAUDE.md`; it directs the agent to load only the selected guidance and run independent focused QA.

Read [scheme/README.md](scheme/README.md) for the bootstrap contract and [scheme/docs/QA_INTEGRATION.md](scheme/docs/QA_INTEGRATION.md) for the boundary between an implementation agent and QA Orchestrator.

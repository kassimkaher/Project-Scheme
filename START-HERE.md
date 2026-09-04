# Project Scheme and QA Orchestrator

This repository has two separate products.

- **I want standalone QA:** use the dashboard and engine in [README.md](README.md).
- **I want to create a new project:** use [PROJECT_BOOTSTRAP.md](scheme/bootstrap/PROJECT_BOOTSTRAP.md).
- **I want to inspect engineering Skills:** browse [scheme/skills](scheme/skills).
- **Project Scheme** is the reusable bootstrap layer in `scheme/`. It gives a new project a small, durable AI context and a link to independent QA.

To bootstrap a project, answer the compact questionnaire in `scheme/bootstrap/questionnaire.md`, save the answers as YAML or JSON, and run:

```bash
npm run scheme:bootstrap -- --answers /path/to/answers.yaml --output /path/to/new-project
```

The generated project receives `CLAUDE.md`, `.ai/`, and, when QA is enabled, `.qa/`. **Do not clone or copy the entire Project-Scheme repository into a generated application.** Start future coding sessions by following that generated `CLAUDE.md`; it directs the agent to load only the selected guidance and run independent focused QA.

Read [scheme/README.md](scheme/README.md) for the bootstrap contract and [scheme/docs/QA_INTEGRATION.md](scheme/docs/QA_INTEGRATION.md) for the boundary between an implementation agent and QA Orchestrator.

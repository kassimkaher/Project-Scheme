# QA integration

Use `npm run qa:run -- --project .qa/qa-system.md --environment qa --mode web --scope checkout` against a running local QA Orchestrator. The CLI calls documented HTTP API routes to import/update the portable definition and start a scoped run; it does not scrape the dashboard. It reports the run id and current `unsafe-local` isolation mode.

# QA integration

QA Orchestrator remains independently usable through its dashboard. Project Scheme adds a portable `.qa/qa-system.md` so a coding session can request focused API, web, or mobile QA after implementing a capability. The QA agent must test and report only; it does not modify the product or replace human acceptance. Keep credentials in a secure catalog or environment, never in `.qa` source files.

The future command shape is documented as `qa run --project .qa/qa-system.md --mode web --scope checkout`; it is not implemented by this repository today.

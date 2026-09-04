# Security model

QA credentials remain encrypted in QA Orchestrator and are redacted from UI, logs, streams, failures, and terminal artifacts. Project Scheme emits no credentials. QA execution currently operates in explicit `unsafe-local` mode: the agent runs with the operator's user permissions and prompt boundaries are not a sandbox.

**OPEN isolation gap:** a restricted worker user or container runner with minimal mounts and target-network allowlists is not implemented. Do not represent the current mode as sandboxed.

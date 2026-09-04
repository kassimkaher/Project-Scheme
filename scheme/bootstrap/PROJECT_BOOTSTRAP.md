# Project bootstrap

Do not begin implementation before collecting the project-defining answers in [questionnaire.md](questionnaire.md). Infer only what the requester already supplied; ask only unanswered decisions that affect architecture, skills, platforms, environments, or QA.

Use [profile-selection.md](profile-selection.md), create an answers YAML file that follows `../schemas/project.schema.json`, then run `npm run scheme:bootstrap -- --answers <file> --output <directory>`. Review the generated `.ai/project.yaml` and selected skills with the project owner before scaffold or feature work.

The bootstrap output intentionally excludes the QA engine and skill source files. Configure real QA URLs and persona catalog references in the generated `.qa/qa-system.md` before importing it into QA Orchestrator.

# Project Scheme

Project Scheme bootstraps software projects without forcing one architecture onto every project. It selects a `small`, `production`, or `enterprise` profile from an explicit questionnaire and emits a machine-readable `.ai/project.yaml`, minimal session context, and optional portable QA definition.

Run `npm run scheme:test` to validate the generator. Run `npm run scheme:bootstrap -- --answers answers.yaml --output ../my-project` to generate a project. The input shape is formalized by `schemas/project.schema.json`; the CLI enforces its required bootstrap fields before generating any files.

`skills/` contains reusable, project-independent skills. Generated projects retain only the selected skill names. `docs/` explains lifecycle, selection, QA, sessions, capability completeness, and research sources.

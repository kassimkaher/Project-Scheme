# First project bootstrap procedure

In the target project, provide `scheme/bootstrap/PROJECT_BOOTSTRAP.md` to the coding agent. For an empty project, answer its compact questionnaire and run `npm run scheme:bootstrap -- --answers answers.yaml --output .`. For an existing project, add `--existing .`; discovery reads manifests and configuration to infer platforms, contracts, and test infrastructure without overwriting source.

The output prints a recommendation and reasons. Accept it or set `project.profile` deliberately in answers. `.ai/project.yaml` is the authoritative machine-readable control plane; `state.md`, `decisions.md`, and capabilities are the durable human-operational memory. Later sessions start at generated `CLAUDE.md`, load only selected Skills, and use `npm run qa:run -- --project .qa/qa-system.md --environment qa --mode web --scope <feature> --wait` for independent QA.

Before an upgrade, commit the target project. Re-run bootstrap with the same answers: v2 migrates v1 control-plane data in memory, writes version 2 only when absent, and never replaces state or decisions. Review the profile recommendation and selected Skills whenever platforms or risk change.

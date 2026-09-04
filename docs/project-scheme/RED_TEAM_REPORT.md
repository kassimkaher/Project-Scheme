# V2 red-team report

V1 defects confirmed: manual validation drift, profile labels mistaken for classification, dropped control-plane fields, placeholder Skills, no existing-project discovery, and QA automation that could start but not close a loop.

V2 fixes: canonical schema-driven validation, deterministic explainable recommendation, lossless normalized project state with a control-plane version, non-destructive migration, structured-Skill validation, existing-project inference, wait/result QA automation, and backup plus restore-safe copy evidence.

Remaining blocker: the macOS sandbox probe proves a real OS boundary can deny unrelated paths, but no production Claude/browser QA runner yet executes inside that boundary with a complete least-privilege profile. `unsafe-local` is still explicit and must not be selected for sensitive real projects.

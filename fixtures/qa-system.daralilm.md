# Dar Al-Ilm — development fixture

NOT the shipped example. This file exists so the orchestrator can be tested
against a real multi-role system during development. It is never served by
/api/example and is never auto-imported.

```qa-config
version: 1
projectId: "dar-al-ilm"

system:
  name: "Dar Al-Ilm"
  description: "Tutoring / education-commerce platform"

environments:
  - id: "qa"
    label: "QA"
    kind: "qa"
    apiBaseUrl: "https://api-learning.aljoodnet.info"
    openapiUrl: "https://api-learning.aljoodnet.info/docs/openapi.yaml"
    webApps:
      - id: "dashboard"
        label: "Unified Dashboard"
        url: "https://learning.aljoodnet.info"
    accountCatalog:
      url: "https://api-learning.aljoodnet.info/qa/accounts.json"
      requiredRoles: ["admin", "teacher", "student"]

# No static credentials: every persona is resolved live from the catalog above at
# the start of each run, so a re-run never uses a retired account.
accounts: []

documentation:
  - label: "QA persona catalog"
    url: "https://api-learning.aljoodnet.info/qa/accounts.json"

qa:
  preferredLanguage: "ar"
  destructiveActions: "allow-build-test-only"
  notes:
    - "Use QA-only records for mutations."
    - "Verify persistence after refresh."
    - "Some personas require TOTP; the catalog publishes a current code per persona."
    - "For web QA, inspect visual density and responsive behaviour, not only functionality."
```

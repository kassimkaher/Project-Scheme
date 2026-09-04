# QA System Specification v1

This file is a **template**, not a project. Nothing here is loaded by the QA
Orchestrator until you fill it in and import it deliberately.

Replace every `example.com` value with your own system. You can also hand this
file to any capable AI agent together with your project documentation and ask it
to produce a filled-in version using exactly the same structure.

```qa-config
version: 1

# Optional. Supply a stable id and re-importing this file will always update the
# same project instead of guessing by name. Recommended for real use.
projectId: "my-system"

system:
  name: "My System"
  description: "One line describing what this system is for."

environments:
  - id: "qa"
    label: "QA"
    kind: "qa"                     # local | qa | staging | production | other
    apiBaseUrl: "https://api.example.com"
    openapiUrl: "https://api.example.com/openapi.yaml"
    webApps:
      - id: "dashboard"
        label: "Dashboard"
        url: "https://app.example.com"

    # OPTIONAL — live persona catalog.
    # If your system publishes QA accounts at a URL, point at it here and the
    # orchestrator will re-fetch it at the start of every run instead of relying
    # on credentials frozen into this file. Any JSON shape with a list of account
    # objects is understood; common field names are detected automatically.
    # accountCatalog:
    #   url: "https://api.example.com/qa/accounts.json"
    #   requiredRoles: ["admin", "member"]
    #   requiredPersonas: []

# Static accounts. Use these when there is no live catalog, or to override a
# single persona from one. Credentials are encrypted at rest on import.
accounts:
  - id: "admin-qa"
    role: "admin"
    label: "QA Admin"
    loginType: "email_password"     # email_password | phone_password | username_password | custom
    credentials:
      identifier: "admin@example.com"
      password: "replace-me"
  - id: "member-qa"
    role: "member"
    label: "QA Member"
    loginType: "email_password"
    credentials:
      identifier: "member@example.com"
      password: "replace-me"

# Optional supporting docs the QA agent should read before testing.
documentation:
  - label: "Product notes"
    url: "https://docs.example.com/qa-notes"

qa:
  preferredLanguage: "en"
  destructiveActions: "allow-build-test-only"   # forbid | allow-build-test-only | allow
  notes:
    - "Use QA-only records for mutations."
    - "Verify persistence after refresh."
    - "Check visual density and responsive behaviour, not only functionality."
```

## Human notes

Add business context the agent cannot infer from the OpenAPI or the UI — rules,
edge cases, things that look broken but are intentional. Do not put production
secrets in this prose.

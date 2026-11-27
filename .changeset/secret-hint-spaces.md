---
"@agentproto/runtime": patch
---

MCP human gate: a compound secret term written with spaces ("Paste your API key", "access token", "private key", "credit card number") is now a secret hint, like its `api_key`, `api-key` and `apikey` forms, so such a question or form is not projected (AIP-45 "No secret in a form", AIP-77 "Flat forms, no secrets").

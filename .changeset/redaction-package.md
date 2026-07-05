---
"@agentproto/redaction": minor
---

Add `@agentproto/redaction`, a vendor-neutral, dependency-free `Redactor` port with built-in `noneRedactor`, `denyListRedactor`, `truncateRedactor`, and `chainRedactors`, plus a `REDACTOR_CATALOG` and `resolveRedactor` for resolving a declarative spec (slug, options, or chain) to a concrete redactor. First consumer is an opt-in Langfuse session tracer that will use it to scrub outbound payloads.

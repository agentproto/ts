---
"@agentproto/driver-http": minor
---

Harden `@agentproto/driver-http` with endpoint path interpolation (with traversal/origin guards), snake_case fallback normalization for `metadata.http`, prototype-pollution guards in `extractResponse`, secret redaction in HTTP error excerpts, and a `safeHttpCollector` driver wrapper enforcing GET-only, lexical + DNS anti-SSRF checks, `redirect: "error"`, streaming response size cap, timeout, JSON content-type checks, and single-source auth header composition.

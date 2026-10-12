---
"@agentproto/runtime": patch
---

Stop repeated failed provider imports across the sentinel, tunnel and sandbox families. Discovery can list packages from pnpm's hoisted virtual store that are not resolvable from the runtime's own module base, so every MCP request re-ran dynamic imports that failed with `ERR_MODULE_NOT_FOUND` — each one entering Node 22's async ESM loader, whose error path leaks a MessagePort per failed import. A bounded, coalescing, 60s-TTL probe cache now answers "missing" once per specifier per window, guarded by a synchronous `import.meta.resolve` preflight (import conditions, same resolution base) so provably missing packages never reach the loader; only the credential-independent module namespace is cached, and provider handles are rebuilt per request with that request's own credentials. The discovered-package list is cached the same way.

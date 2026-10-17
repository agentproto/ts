---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Fixed `agentproto mcp login <alias> --url <url>` always failing with `uses oauth but no keychain secret store is configured`, even right after printing the consent URL and scopes — the CLI's own `setMcpCredentialDeps` call never reached `openMcpClient`'s `createDaemonOAuthProvider`. Root cause: `@agentproto/runtime` ships `./mcp-oauth` and `./mcp-client-pool` as separate tsup entries (`splitting: false`), so each bundles its own private copy of `mcp-credential-deps.ts`'s module state; a `setMcpCredentialDeps` call reached through one subpath (or, as the CLI did, through the now-removed `./mcp-credential-deps` entry) is invisible to `getMcpCredentialDeps()` reached through another. `openMcpClient`'s `OpenMcpClientOptions` now accepts an explicit `oauthSecrets` override, which `mcp login`'s verify step and the daemon's `mcp-proxy.ts` both pass — the ambient singleton is now only a same-bundle convenience fallback, never load-bearing across a subpath boundary. The dead `./mcp-credential-deps` export is removed.

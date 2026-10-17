---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Imported remote (http/sse) MCPs can now authenticate with OAuth 2.1 (RFC 9728 discovery, RFC 7591 dynamic client registration, PKCE). `@agentproto/runtime` exposes the generic `McpOAuthProvider` (plus the `mcp-client-pool` and `mcp-credential-deps` subpath exports) and a new `oauth` field on `McpConnectionConfig`; `@agentproto/cli` adds `agentproto mcp login <alias> [--url <url>] [--scope "a b"] [--no-open]` and `agentproto mcp logout <alias>`, storing client + tokens as one keychain item per import. The daemon refreshes tokens silently and never starts an interactive flow, failing with `oauth login required … run: agentproto mcp login <alias>` when credentials are missing or revoked.

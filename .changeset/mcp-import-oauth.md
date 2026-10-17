---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Imported MCPs can now authenticate with OAuth 2.1 (RFC 9728 discovery, RFC 7591 dynamic client registration, PKCE), so remote MCPs that accept no API key or static header (e.g. Qonto) become usable by daemon-spawned agents. New `agentproto mcp login <alias> [--url <url>] [--scope "a b"] [--no-open]` runs the consent on a one-shot 127.0.0.1 loopback listener, prints the authorization URL and the requested scopes before the click, stores the client + tokens as one keychain item per import (never in `imported-mcps.json`), verifies with `tools/list`, and only then records `auth: { type: "oauth" }` on the import (`--url` creates a manual http import). `mcp logout` forgets the stored state. The daemon refreshes tokens on its own and never starts an interactive flow: when credentials are missing or revoked it fails with `oauth login required … run: agentproto mcp login <alias>`. Stored state is bound to the server origin, so a live-repointed entry never receives tokens. `@agentproto/runtime` adds the `./mcp-oauth`, `./mcp-client-pool` and `./mcp-credential-deps` exports and an `oauth` field on `McpConnectionConfig`.

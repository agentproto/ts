---
name: ap-import-mcp
description: Discover, import, and call external MCP servers from the agentproto daemon — mcp_discovered_list to find servers in existing tool configs, mcp_import to register them, mcp_imported_tool_list to fetch inputSchemas, and mcp_imported_call to invoke. Trigger when the user mentions an MCP server, importing tools, chrome-devtools MCP, or calling an MCP tool.
---

# ap-import-mcp

## When to use

- The user already has an MCP server configured in claude-code, cursor, or goose and wants it usable here.
- You need a tool that only exists behind an MCP server (e.g. `chrome-devtools`, `context7`).
- An imported MCP's tools are failing and you need to see the real upstream schema.

## Discover → import → inspect → call

```json
// 1. What MCPs exist in the user's other tooling?
mcp_discovered_list({})
// → [{ "id": "claude-code:project:/repo:chrome-devtools", "name": "chrome-devtools", ... }]

// 2. Import the one you need (alias defaults to its name)
mcp_import({ "sourceMcpId": "claude-code:project:/repo:chrome-devtools", "alias": "chrome-devtools" })

// 3. See what it exposes + connection state
mcp_imported_status({})                       // every import: status, transport, tool count
mcp_imported_list({})                         // the curated set only
mcp_imported_tool_list({ "alias": "chrome-devtools" })  // tool names + upstream inputSchema (verbatim JSON Schema)

// 4. Call a tool — build args from the schema you just fetched
mcp_imported_call({ "alias": "chrome-devtools", "toolName": "take_snapshot", "args": {} })
```

`mcp_imported_call` returns the full upstream result including `isError` flags — the proxy forwards verbatim and does not validate. Tool names are the upstream's own, not namespaced.

## Remove

```json
mcp_imported_remove({ "id": "claude-code:project:/repo:chrome-devtools" })
```

Removal takes the server out of the daemon's curated set; the source config (claude/cursor) is untouched.

## Gotchas

- **Asking beats assuming**: importing is read-only metadata, but the *first call executes upstream code*. If the user did not mention the server, ask before importing and calling.
- First call on a stdio server pays npx spawn latency (~1-2s handshakes); HTTP/SSE connects in under 100ms. Don't mistake the first slow call for a broken server.
- Always fetch `inputSchema` with `mcp_imported_tool_list` before building `args` — guessing a schema is the #1 source of failed calls. The proxy will not save you from a wrong shape; the upstream's own validation is the only check.
- The snapshot is captured at import time: if the user later deletes the server from claude/cursor, the imported copy keeps working (and vice versa).
- Upstream errors come back exactly as the server produced them — an `isError: true` result is data, not a transport failure.

## Pointers

- agentproto — daemon overview; where imports are registered.
- ap-adapters — adapter-level capabilities (some harnesses carry their own MCP config).
- ap-transmit — the other ingress direction: webhooks in, messages out.
- extend-agentproto — building your own MCP/tools for the daemon.

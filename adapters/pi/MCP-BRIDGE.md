# MCP → pi-tools bridge

Pi ships **no MCP client**. This adapter still lets the host inject
`mcpServers` into a pi session — including the daemon's `agent_start`
orchestration gateway — by bridging every MCP tool into a native **pi tool**
through pi's own TypeScript **extension** system. Pi never speaks MCP; the
bridge extension does, on pi's behalf.

## How it works

```
host connect({ mcpServers })
        │
        ▼
adapter (client.ts)                         ┌─ pi child process ────────────┐
  1. enumerate each server: tools/list      │  pi --mode rpc                 │
  2. write config JSON  ───────────────────▶│    -e mcp-bridge-extension.mjs │
     (PI_MCP_BRIDGE_CONFIG)                  │    PI_MCP_BRIDGE_CONFIG=…      │
  3. spawn pi with -e + env                  │                               │
                                             │  extension registers one pi   │
                                             │  tool per MCP tool; execute →  │
                                             │  @modelcontextprotocol/sdk →   │
                                             │  callTool() on the MCP server  │
                                             └───────────────────────────────┘
```

1. **Enumerate (adapter, `src/mcp-bridge/enumerate.ts`).** On `connect()`, for
   each injected `AcpMcpServer` the adapter opens a short-lived MCP client,
   `tools/list`, and closes it. Enumerating host-side surfaces connect/list
   errors early and keeps the extension's registration synchronous.
2. **Config JSON (`config.ts` / `parse-config.ts`).** The enumerated tools +
   server specs are written to a per-session temp file
   (`{ servers:[…], tools:[{ toolName, server, remoteName, description,
   inputSchema }] }`). Path is passed via `PI_MCP_BRIDGE_CONFIG`.
3. **Spawn.** The adapter adds `-e <dist>/mcp-bridge-extension.mjs` to the
   `pi --mode rpc` argv (additive — pi's own extension discovery is untouched)
   and sets `PI_MCP_BRIDGE_CONFIG` in the child env. The extension path is
   resolved from the adapter's own module URL (`import.meta.url`), not cwd.
4. **Register (extension, `src/mcp-bridge/extension.ts`).** At load, pi calls
   the extension's default export; it reads the config and calls
   `pi.registerTool(...)` once per tool — **synchronously**. Each tool's
   `execute` lazily connects (memoized per server) and proxies via
   `@modelcontextprotocol/sdk` `callTool`, mapping the result back to pi's
   tool-result shape.

## Tool namespacing

Bridged tools are named `mcp__<server>__<tool>`, sanitized to `[a-zA-Z0-9_-]`
and capped at 64 chars (provider tool-name limits). Collisions after
sanitizing/truncation get a `_2`, `_3`, … suffix. Namespacing avoids clashing
with pi's built-in tools (`read`, `bash`, …).

## Result mapping (`map-result.ts`)

MCP `callTool` returns `{ content: ContentBlock[], isError? }`. The bridge maps
**text blocks directly**; every **non-text block** (image / audio / resource /
resource_link) is **stringified** into a labeled text block
(`[non-text MCP content] …`). An `isError: true` result is surfaced as text the
model can read and recover from (MCP's tool-error convention), prefixed
`MCP tool error (<server>/<tool>): …`, with `details.isError` set for logs. A
thrown/rejected SDK call is caught and returned as an error tool result (pi
never sees an uncaught throw).

## The two make-or-break details (verified against pi 0.80.3, in source AND live)

- **Synchronous registration at extension load works.** pi's loader awaits the
  extension factory (`core/extensions/loader.ts` — `await factory(api)`) and
  `registerTool()` is valid during load (loader comment: "registerTool() is
  valid during extension load"). The bridge registers synchronously in the
  factory (like pi's own `hello.ts` example), so it does not depend on any
  async-load timing. Proven live: pi called `mcp__echo__echo` in a `--mode rpc`
  session.
- **Import resolution "just works" — because the extension imports NO pi
  package.** pi loads extensions with **jiti**; in a Node install (the global
  `pi` bin is a `#!/usr/bin/env node` script, not the Bun binary) jiti aliases
  `@earendil-works/*` + `typebox` to pi's own install
  (`loader.ts` `getAliases()`), so an extension living outside pi's tree still
  resolves them. The bridge sidesteps the question entirely: it uses pi's
  **structural** runtime contract (a `registerTool` method; a plain JSON Schema
  as `parameters`) and imports nothing from `@earendil-works/*`
  (`grep -c "@earendil-works" dist/mcp-bridge-extension.mjs` → `0`). The MCP SDK
  is **inlined** into the extension bundle (pi's process can't resolve it
  otherwise); only node builtins stay external.

### Why a raw JSON Schema is a valid pi `parameters`

pi expects a TypeBox `TSchema`, but validates tool arguments with
`Compile(tool.parameters)` (`pi-ai/utils/validation.ts`). A raw MCP JSON Schema
compiles + validates unchanged (verified: `Compile({type:"object",…}).Check`
respects `required`/types), and pi additionally runs JSON-Schema-aware coercion
when the schema carries no TypeBox `Kind` symbol. So the bridge passes the MCP
`inputSchema` through verbatim — no `Type.Unsafe`, no `@earendil-works/pi-ai`
import, no cast.

### ESM/CJS interop

The inlined MCP SDK pulls in CJS deps (e.g. `cross-spawn`) that `require()` node
builtins. The bundle banner injects a real `require`
(`createRequire(import.meta.url)`) so esbuild's `__require` helper uses it
instead of throwing "Dynamic require … is not supported".

## Limitations / known gaps

- **Image & binary content** returned by an MCP tool is stringified to text, not
  passed to pi as an image block (pi supports image tool results, but mapping
  binary payloads through faithfully is deferred). Text tools (the common case)
  are lossless.
- **No MCP sampling / elicitation / roots.** The bridge is one-directional
  (pi → MCP tool call → result). MCP servers that request LLM sampling back from
  the client are not supported.
- **Cancellation** — pi passes an `AbortSignal` into `execute`; the bridge
  forwards it to the SDK `callTool({ signal })`. Whether the remote server
  honors it depends on the server.
- **Brokered credentials.** Only static `headers` on an `AcpMcpServer` are
  honored for http/sse servers. A `credentialRef` must be resolved into headers
  by the host **before** injection (the bridge does not call the credential
  broker).
- **Double connect for stdio.** The adapter probes each stdio server once to
  enumerate, then the extension re-spawns it for live calls (two spawns total).

## Live e2e

`e2e/echo-mcp-server.mjs` is a ~30-line stdio MCP server exposing one `echo`
tool; `e2e/run-e2e.mjs` injects it via `piRuntime().start({ mcpServers })`,
prompts pi to call it, and asserts the stream shows a `tool-call` for
`mcp__echo__echo`, a `tool-result` carrying the echoed text, and a completed
`turn-end`. Run (needs `ANTHROPIC_API_KEY` + a global `pi`), after a build:

```bash
pnpm --filter @agentproto/adapter-pi build
node adapters/pi/e2e/run-e2e.mjs
```

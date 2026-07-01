# agentproto — thread daemonMcpUrl into the scoped orchestrator sub-gateway

## Context

`feat/hermes-default-mcp` (PR #138, merged) fixed the root `/mcp` route:
`agent_start` now defaults `mcpServers` to the daemon's own gateway when
`adapter === "hermes"` and the caller passed none, so hermes no longer
silently spawns as a zero-tool chat-only session. That PR explicitly flagged
a follow-up gap, confirmed by the reviewer too: the SCOPED orchestrator
sub-gateway (`/mcp/orchestrator?scope=...`, used when a child session is
itself made an orchestrator via `agent_start({orchestrator: true})`) doesn't
get the same default. A hermes session spawned recursively through that
route, with no explicit `mcpServers`, still gets zero tools.

## Grounded findings (verified against `main` post-#139 merge)

- `packages/runtime/src/orchestrator-gateway.ts:201-224`
  (`OrchestratorGatewayDeps` interface) — has `registry`, `sessionEvents`,
  `eventRing`, `supervisor?`, `resolveAgentAdapter?`, `listAgentAdapters?`,
  `orchestratorInjector?`, `webhookNotifier?`. **No `daemonMcpUrl` field.**
- `orchestrator-gateway.ts:238-273` (`createOrchestratorMcpServerFactory`) —
  calls `registerSessionTools(server, {...})` at line 247 with a subset of
  `deps` fields. `daemonMcpUrl` is never in that object, so
  `registerSessionTools`'s hermes-default logic (added in #138 — `if
  (!mcpServers && input.adapter === "hermes" && daemonMcpUrl) {...}`,
  inside `registerAgentTools` which `registerSessionTools` wraps) never
  fires on this path — `daemonMcpUrl` is `undefined` here, so the condition
  is always false.
- `packages/runtime/src/index.ts:305` — `daemonMcpUrl` IS computed once at
  boot (`` `http://127.0.0.1:${port}/mcp` ``).
- `index.ts:538-553` — `createOrchestratorMcpServerFactory({...})` is called
  with `workspace, name, version, registry, sessionEvents, eventRing,
  supervisor, orchestratorInjector, webhookNotifier, resolveAgentAdapter?,
  listAgentAdapters?` — **`daemonMcpUrl` is NOT included**, even though the
  variable is already in scope at this point in the same function (it's
  used a few lines later, at `index.ts:596`, for the ROOT `/mcp` server's
  own `registerSessionTools` call).

This is a pure omission — the variable already exists in scope at the call
site, it just wasn't threaded through.

## What to build

1. **`packages/runtime/src/orchestrator-gateway.ts`**:
   - Add `daemonMcpUrl?: string` to `OrchestratorGatewayDeps` (~line 224,
     alongside the other optional deps, with a doc comment mirroring the one
     on `RegisterAgentToolsOptions.daemonMcpUrl` from #138).
   - Add `daemonMcpUrl: deps.daemonMcpUrl` to the `registerSessionTools(...)`
     call at line 247.

2. **`packages/runtime/src/index.ts`**:
   - Add `daemonMcpUrl` to the `createOrchestratorMcpServerFactory({...})`
     call at ~line 538 (the variable is already in scope — this is a
     one-line addition).

## Explicitly out of scope

- No other behavior changes. This is strictly completing the #138 fix's
  coverage to the second MCP mount point — same semantics (opt-out via
  explicit `mcpServers: []` still respected, only fires for `adapter ===
  "hermes"` with no `mcpServers` supplied at all).

## Verification

1. `pnpm --filter @agentproto/runtime check-types` — clean.
2. Full `@agentproto/runtime` test suite — no regressions. Consider adding
   a small test alongside the existing orchestrator tests
   (`orchestrator-role.test.ts` / `orchestrator-guardrails.test.ts`) that
   spawns a hermes child through the scoped `/mcp/orchestrator` route with
   no `mcpServers` and confirms the daemon gateway entry is present in the
   resulting session descriptor — mirroring how #138 verified the root
   route.
3. Live-test if a daemon is reachable: `agent_start({orchestrator: true})`
   → prompt the parent to spawn a hermes child with no `mcpServers` through
   its scoped sub-gateway → confirm the child gets tools (not a chat-only
   session).

## Critical files

- `packages/runtime/src/orchestrator-gateway.ts` — `OrchestratorGatewayDeps`,
  `createOrchestratorMcpServerFactory`
- `packages/runtime/src/index.ts` (~line 538) — the factory call site

## Report back

Exact diff, check-types/test results, and honest account of live
verification (or why it wasn't possible).

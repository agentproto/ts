/**
 * Shared `agent_start` spawn logic — orchestrator scoped sub-gateway
 * minting, `mcpServers` merge, hermes default-mcpServers safety net,
 * depth/quota checks. Extracted from `agent-tools.ts` (the MCP tool)
 * so the HTTP route can reuse it without re-implementing (and
 * re-drifting from) the same behaviour.
 */

import type { AcpMcpServer } from "@agentproto/acp"
import type { SessionsRegistry, SessionDescriptor } from "./sessions.js"
import type { AgentAdapterResolver } from "./http-server.js"
import {
  loadWorkspacesConfig,
  findWorkspace,
  getActiveWorkspace,
} from "./workspaces-config.js"
import type { OrchestratorScope } from "./orchestrator-gateway.js"
import type { WebhookNotifier } from "./webhook-notifier.js"

/** Matches `RegisterAgentToolsOptions.buildOrchestratorMcp` in
 *  agent-tools.ts — kept as its own alias here since that's the shape
 *  actually passed in (opts required), not the more permissive
 *  `OrchestratorInjector` (opts optional) from orchestrator-gateway.ts. */
export type BuildOrchestratorMcp = (opts: {
  tools?: readonly string[]
  caller?: OrchestratorScope
  maxDepth?: number
  maxChildren?: number
}) => {
  entry: AcpMcpServer
  bindLifecycle: (sessionId: string) => () => void
}

/** Strip ANSI escapes and drop the ACP framing/marker noise (`── … ──`
 *  turn frames + `[thought]` / `[tool]` lines) so the lines read as plain,
 *  human-friendly text. Used by `agent_output({clean})` and the
 *  `spawnAgentSession({wait})` one-shot output. */
export function cleanAgentLines(lines: string[]): string[] {
  return lines
    .map(l => l.replace(/\x1b\[[0-9;]*m/g, ""))
    .filter(l => {
      const t = l.trim()
      return !t.startsWith("──") && !/^\[(thought|tool)\b/.test(t)
    })
}

export interface SpawnAgentSessionDeps {
  registry: SessionsRegistry
  /** Required — callers must check for its absence themselves (the MCP
   *  tool and HTTP route each have their own "not enabled" response
   *  shape for the missing-resolver case). */
  resolveAgentAdapter: AgentAdapterResolver
  /** Optional orchestrator-injection builder (WP3). See
   *  `RegisterAgentToolsOptions.buildOrchestratorMcp` for the full
   *  contract. Omitted → `orchestrator` is rejected with
   *  `orchestrator_not_enabled`. */
  buildOrchestratorMcp?: BuildOrchestratorMcp
  /** The daemon's own plain `/mcp` gateway URL. See
   *  `RegisterAgentToolsOptions.daemonMcpUrl`. */
  daemonMcpUrl?: string
  /** Calling orchestrator's scope (orchestrator WP4). See
   *  `RegisterAgentToolsOptions.callerScope`. */
  callerScope?: OrchestratorScope
  /** Optional webhook notifier — see `RegisterAgentToolsOptions.webhookNotifier`. */
  webhookNotifier?: WebhookNotifier
}

export interface SpawnAgentSessionInput {
  adapter: string
  cwd?: string
  workspaceSlug?: string
  /** Reattach to a pre-existing adapter-native session (claude-code's
   *  conversation id, hermes' chat handle, …) instead of starting
   *  blank. Not exposed on the MCP `agent_start` tool today — only the
   *  HTTP route (`sessions restart`) passes this. */
  resumeSessionId?: string
  prompt?: string
  label?: string
  mode?: string
  /** Manifest-declared option id → value map (AIP-45 `options`), applied
   *  at spawn time alongside `mode`. Forwarded verbatim to the driver's
   *  `startSession({ options })` → `composeSpawn`'s option patches. */
  options?: Record<string, boolean | number | string>
  model?: string
  effort?: string
  mcpServers?: AcpMcpServer[]
  orchestrator?: boolean | { tools?: string[]; maxDepth?: number; maxChildren?: number }
  notifyUrl?: string
  wait?: boolean
  maxCostUsd?: number
}

export type SpawnAgentSessionResult =
  | { ok: true; descriptor: SessionDescriptor; output?: string[] }
  | {
      ok: false
      code:
        | "adapter_not_found"
        | "no_cwd"
        | "orchestrator_not_enabled"
        | "orchestrator_max_depth_exceeded"
        | "orchestrator_child_quota_exceeded"
        | "agent_spawn_failed"
      message: string
      details?: Record<string, unknown>
    }

export async function spawnAgentSession(
  deps: SpawnAgentSessionDeps,
  input: SpawnAgentSessionInput,
): Promise<SpawnAgentSessionResult> {
  const {
    registry,
    resolveAgentAdapter,
    buildOrchestratorMcp,
    daemonMcpUrl,
    callerScope,
    webhookNotifier,
  } = deps

  // cwd resolution mirrors the HTTP route: explicit cwd wins,
  // then workspaceSlug lookup, then active workspace, then a
  // hard error (the operator probably forgot a step).
  let cwd = input.cwd
  let resolvedSlug = input.workspaceSlug ?? "default"
  if (!cwd) {
    try {
      const config = await loadWorkspacesConfig()
      const ws = input.workspaceSlug
        ? findWorkspace(config, input.workspaceSlug)
        : getActiveWorkspace(config)
      if (ws) {
        cwd = ws.path
        resolvedSlug = ws.slug
      }
    } catch {
      // fall through to error below
    }
  }
  if (!cwd) {
    return {
      ok: false,
      code: "no_cwd",
      message:
        "agent_start: no cwd resolvable. Pass `cwd` explicitly, " +
        "or pass `workspaceSlug` matching `agentproto workspace list`, " +
        "or set an active workspace via `agentproto workspace use <slug>`.",
    }
  }
  const resolved = await resolveAgentAdapter(input.adapter)
  if (!resolved) {
    return {
      ok: false,
      code: "adapter_not_found",
      message: `agent_start: adapter "${input.adapter}" not found. Try \`agentproto install <slug>\` first.`,
    }
  }
  // ── Recursion guardrails (WP4) ──────────────────────────────
  // When this call arrives through the scoped sub-gateway,
  // `callerScope` is the spawning orchestrator's identity. Enforce
  // the depth cap and per-parent child quota BEFORE spawning, and
  // compute the new session's parent attribution. A direct `/mcp`
  // spawn (no callerScope) is a root: depth 0, no parent, no caps.
  const childDepth = callerScope ? callerScope.depth + 1 : 0
  const parentSessionId = callerScope?.ownerSessionId
  if (callerScope) {
    if (childDepth > callerScope.maxDepth) {
      return {
        ok: false,
        code: "orchestrator_max_depth_exceeded",
        message:
          `Spawn rejected: this orchestrator is at depth ${callerScope.depth}; ` +
          `a child would be depth ${childDepth}, exceeding the max depth ` +
          `${callerScope.maxDepth}. No session was created.`,
        details: {
          depth: callerScope.depth,
          childDepth,
          maxDepth: callerScope.maxDepth,
        },
      }
    }
    // Count this orchestrator's currently-alive children. Killed/
    // exited children free a slot (the cap bounds concurrent load,
    // not lifetime spawns).
    const aliveChildren = parentSessionId
      ? registry.list().filter(
          s =>
            s.parentSessionId === parentSessionId &&
            (s.status === "running" || s.status === "starting"),
        ).length
      : 0
    if (aliveChildren >= callerScope.maxChildren) {
      return {
        ok: false,
        code: "orchestrator_child_quota_exceeded",
        message:
          `Spawn rejected: this orchestrator already has ${aliveChildren} ` +
          `alive children, at the max of ${callerScope.maxChildren}. ` +
          `Kill one before spawning another. No session was created.`,
        details: {
          aliveChildren,
          maxChildren: callerScope.maxChildren,
        },
      }
    }
  }
  // Orchestrator role (WP3): when requested, mint a scoped
  // sub-gateway token and MERGE its `mcpServers` entry with any
  // caller-provided ones (WP1) — both coexist on the child's
  // session. The child thus receives the curated orchestration
  // toolset and can spawn + supervise its own sub-agents. The
  // token is revoked when the session exits (bindLifecycle below).
  // When the spawn is itself recursive (callerScope present), the
  // child's token inherits depth+1 and is bounded by the caller's
  // tools (non-re-grant — a child can't widen past its parent).
  let mcpServers = input.mcpServers
  // hermes (unlike claude-code) has zero built-in tools — without an
  // explicit `mcpServers`, it silently spawns as a chat-only session
  // with no error. Default it to the daemon's own gateway so it's no
  // longer possible to get this wrong by omission. An explicit `[]`
  // is a deliberate opt-out and must be respected as such, so this
  // only fires when the caller passed no `mcpServers` at all.
  if (!mcpServers && input.adapter === "hermes" && daemonMcpUrl) {
    mcpServers = [{ name: "agentproto", transport: "http", ref: daemonMcpUrl }]
  }
  let bindOrchestratorLifecycle:
    | ((sessionId: string) => () => void)
    | undefined
  if (input.orchestrator !== undefined && input.orchestrator !== false) {
    if (!buildOrchestratorMcp) {
      return {
        ok: false,
        code: "orchestrator_not_enabled",
        message:
          "agent_start: `orchestrator` is not enabled — the daemon " +
          "was started without the scoped orchestrator sub-gateway. Wire " +
          "`buildOrchestratorMcp` in createGateway (it needs the scope-token " +
          "registry + HTTP port + session-event bus).",
      }
    }
    const orchestratorOpts =
      typeof input.orchestrator === "object" ? input.orchestrator : undefined
    const requestedTools = orchestratorOpts?.tools
    const injection = buildOrchestratorMcp({
      ...(requestedTools ? { tools: requestedTools } : {}),
      ...(callerScope ? { caller: callerScope } : {}),
      ...(orchestratorOpts?.maxDepth !== undefined
        ? { maxDepth: orchestratorOpts.maxDepth }
        : {}),
      ...(orchestratorOpts?.maxChildren !== undefined
        ? { maxChildren: orchestratorOpts.maxChildren }
        : {}),
    })
    mcpServers = [...(mcpServers ?? []), injection.entry]
    bindOrchestratorLifecycle = injection.bindLifecycle
  }
  try {
    // The registry doesn't assign a session id until `spawnAgent`
    // returns below, but `onActivity` can start firing as soon as
    // `startSession` connects — this box lets the closure defer
    // pulsing until the id is known, dropping any pre-spawn activity.
    let liveSessionId: string | undefined
    const agentSession = await resolved.startSession({
      cwd,
      ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.options && Object.keys(input.options).length > 0
        ? { options: input.options }
        : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      onActivity: () => {
        if (liveSessionId) registry.pulseActivity(liveSessionId)
      },
    })
    const desc = registry.spawnAgent({
      workspaceSlug: resolvedSlug,
      cwd,
      agentSession,
      adapterSlug: input.adapter,
      ...(input.model ? { model: input.model } : {}),
      ...(input.wait && input.prompt ? {} : input.prompt ? { initialPrompt: input.prompt } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      // Parent attribution + depth (WP4) — only set for spawns that
      // arrived via the scoped sub-gateway; root spawns stay
      // parentless at depth 0.
      ...(parentSessionId ? { parentSessionId } : {}),
      depth: childDepth,
      ...(resolved.commandPreview
        ? { commandPreview: resolved.commandPreview }
        : {}),
      ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
      ...(resolved.readUsage ? { readUsage: () => resolved.readUsage!(agentSession.sessionId) } : {}),
    })
    liveSessionId = desc.id
    // Bind the scope-token's lifetime to the child session — once
    // it exits, the token is revoked so it can't outlive its child.
    bindOrchestratorLifecycle?.(desc.id)
    // Per-session webhook: register if notifyUrl was supplied and
    // the notifier is wired. Unregistered on session:exited by the
    // gateway's session-event bus handler.
    if (input.notifyUrl && webhookNotifier) {
      webhookNotifier.register(desc.id, input.notifyUrl)
    }
    // wait mode: block until the first turn completes, then return
    // the descriptor with cleaned output appended.
    if (input.wait && input.prompt) {
      await registry.sendPrompt(desc.id, input.prompt)
      const waitLines: string[] = []
      const waitUnsub = registry.attach(desc.id, (line: string) => {
        waitLines.push(line)
      })
      if (waitUnsub) waitUnsub()
      const waitTail = waitLines.slice(-80)
      const output = cleanAgentLines(waitTail)
      return { ok: true, descriptor: desc, output }
    }
    return { ok: true, descriptor: desc }
  } catch (err) {
    return {
      ok: false,
      code: "agent_spawn_failed",
      message: `agent_start: spawn failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
}

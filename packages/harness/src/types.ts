/**
 * @agentproto/harness — shared types.
 *
 * The harness wraps the daemon's session tools (`agent_start`,
 * `agent_prompt`, `agent_output`, `agent_kill`,
 * `session_monitor`) exposed over the `/mcp` endpoint. These types describe the
 * client-side contract; the wire shapes mirror the tool schemas in
 * `@agentproto/runtime` (`session-tools.ts`, `orchestration-tools.ts`).
 */

/** Lifecycle event a turn can settle on. */
export type TurnEvent = "turn-end" | "awaiting-input" | "exited" | "any"

/**
 * Result of `AgentHandle.waitForTurn` / `session_monitor`. On a real match,
 * `event` is one of `"turn-end"|"awaiting-input"|"exited"` and `timedOut` is
 * absent/falsy. On a clean timeout, the daemon returns `{ timedOut: true,
 * sessionIds }` with no `event` field at all — there is no `"timeout"`
 * literal on the wire.
 */
export interface TurnResult {
  sessionId?: string
  event?: TurnEvent
  status?: string
  awaitingInput?: boolean
  timedOut?: boolean
  sessionIds?: string[]
}

/**
 * MCP-server mount forwarded verbatim to `agent_start.mcpServers`
 * (→ `session/new.mcpServers` on the ACP arm).
 */
export interface McpServerMount {
  name: string
  transport: "stdio" | "http" | "sse"
  ref?: string
  [k: string]: unknown
}

/**
 * Scoped-orchestrator request — forwarded to `agent_start.orchestrator`.
 * `true` = the default curated subset; the object form narrows it.
 */
export type OrchestratorOption =
  | boolean
  | {
      tools?: string[]
      maxDepth?: number
      maxChildren?: number
    }

/**
 * Args handed to `agent_start`. 1:1 with the tool schema
 * (`session-tools.ts:241-374`).
 */
export interface StartAgentArgs {
  adapter: string
  cwd?: string
  workspaceSlug?: string
  prompt?: string
  label?: string
  model?: string
  /** Canonical provider route for a routed model.  This must travel with a
   * sandbox handoff: a fresh daemon cannot infer that (for example) a Kimi
   * model is meant to bill Moonshot rather than the adapter's native rail. */
  route?: {
    gateway: string
    baseUrl?: string
  }
  effort?: string
  mcpServers?: McpServerMount[]
  orchestrator?: OrchestratorOption
  notifyUrl?: string
  /** Deterministic billing-auth mode + explicit credential, forwarded to
   *  `agent_start.auth`. Needed when the target daemon has no credential of
   *  its own (e.g. a fresh sandbox box, whose adapters never inherit the
   *  parent shell env for claude-code subscription auth). */
  auth?: {
    mode?: "subscription" | "api-key"
    token?: string
    apiKey?: string
  }
}

/** Session descriptor as returned by `agent_start` (subset). */
export interface SessionDescriptor {
  id: string
  label?: string
  status: string
  adapterSlug?: string
  cwd?: string
  parentSessionId?: string
  depth?: number
  startedAt: string
}

/** Connection options for the shared MCP transport. */
export interface ConnectHarnessOptions {
  /** Daemon MCP endpoint. Default `http://127.0.0.1:18790/mcp`
   *  (or `AGENTPROTO_MCP_URL`). */
  url?: string
}

/**
 * The uniform contract every harness resolves to. A typed wrapper over a
 * single live daemon session.
 */
export interface AgentHandle {
  readonly sessionId: string
  readonly adapter: string
  readonly model?: string
  /** Send a follow-up turn (fire-and-forget at the daemon). */
  send(prompt: string): Promise<void>
  /** Block until this session ends its current turn (`session_monitor`). */
  waitForTurn(opts?: { timeoutMs?: number }): Promise<TurnResult>
  /** Convenience: `send` + `waitForTurn` + return the new output tail. */
  ask(prompt: string, opts?: { timeoutMs?: number }): Promise<string>
  /** Tail the ring buffer (`agent_output`). */
  output(opts?: { lastN?: number }): Promise<string>
  /** SIGTERM the session (`agent_kill`). */
  kill(): Promise<void>
}

/** Coding context injected by the coder harness into its spawn prompt. */
export interface CoderContext {
  /** Short stack description, e.g. "TypeScript monorepo, pnpm, tsup" */
  stack?: string
  /** Coding conventions, e.g. "ESM-only, no default exports except React" */
  conventions?: string
  /** Gate commands that must stay green before declaring done. */
  gateCmds?: string[]
  /** Extra context injected verbatim. */
  extra?: string
}

/** Alias for the spec-facing name. */
export type StartArgs = StartAgentArgs

/**
 * @agentproto/harness — shared types.
 *
 * The harness wraps the daemon's session tools (`start_agent_session`,
 * `prompt_agent_session`, `get_agent_session_output`, `kill_agent_session`,
 * `wait_for_any`) exposed over the `/mcp` endpoint. These types describe the
 * client-side contract; the wire shapes mirror the tool schemas in
 * `@agentproto/runtime` (`session-tools.ts`, `orchestration-tools.ts`).
 */

/** Lifecycle event a turn can settle on. `timeout` is harness-side only. */
export type TurnEvent =
  | "turn-end"
  | "awaiting-input"
  | "exited"
  | "any"
  | "timeout"

/** Result of `AgentHandle.waitForTurn` / `wait_for_any`. */
export interface TurnResult {
  sessionId: string
  event: TurnEvent
  status?: string
  awaitingInput?: boolean
}

/**
 * MCP-server mount forwarded verbatim to `start_agent_session.mcpServers`
 * (→ `session/new.mcpServers` on the ACP arm).
 */
export interface McpServerMount {
  name: string
  transport: "stdio" | "http" | "sse"
  ref?: string
  [k: string]: unknown
}

/**
 * Scoped-orchestrator request — forwarded to `start_agent_session.orchestrator`.
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
 * Args handed to `start_agent_session`. 1:1 with the tool schema
 * (`session-tools.ts:241-374`).
 */
export interface StartAgentArgs {
  adapter: string
  cwd?: string
  workspaceSlug?: string
  prompt?: string
  label?: string
  model?: string
  effort?: string
  mcpServers?: McpServerMount[]
  orchestrator?: OrchestratorOption
  notifyUrl?: string
}

/** Session descriptor as returned by `start_agent_session` (subset). */
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
  /** Block until this session ends its current turn (`wait_for_any`). */
  waitForTurn(opts?: { timeoutMs?: number }): Promise<TurnResult>
  /** Convenience: `send` + `waitForTurn` + return the new output tail. */
  ask(prompt: string, opts?: { timeoutMs?: number }): Promise<string>
  /** Tail the ring buffer (`get_agent_session_output`). */
  output(opts?: { lastN?: number }): Promise<string>
  /** SIGTERM the session (`kill_agent_session`). */
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

/** A unit of work the supervisor harness assigns to a sub-agent. */
export interface WorkPackage {
  id: string
  title: string
  scope?: string
  files?: string[]
  gate?: string
}

/** Alias for the spec-facing name. */
export type StartArgs = StartAgentArgs

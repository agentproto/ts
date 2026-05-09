/**
 * AIP-45 AgentCliDefinition + AgentCliHandle.
 *
 * Mirrors `resources/aip-45/draft/AGENT-CLI.schema.json`. Top-level
 * fields cover the binary's install / version / auth / sandbox /
 * protocol surface; `protocol` discriminates between ACP, MCP, and
 * proprietary adapter arms.
 */

import type { StreamEvent } from "@agentproto/acp"

export type { StreamEvent }

export type AgentCliProtocol = "acp" | "mcp" | "proprietary"
export type AgentCliSessionMode = "ephemeral" | "persistent" | "resumable"

export interface AgentCliInstallMethod {
  method:
    | "brew"
    | "apt"
    | "dnf"
    | "pacman"
    | "choco"
    | "scoop"
    | "npm"
    | "pip"
    | "cargo"
    | "go"
    | "curl"
    | "download"
    | "vendored"
  package?: string
  url?: string
  path?: string
  extract_bin?: string
  verify_sha256?: string
  global?: boolean
  user?: boolean
  experimental?: boolean
}

export interface AgentCliVersionCheck {
  cmd: string
  parse: string
  range: string
  timeout_ms?: number
}

export interface AgentCliAuth {
  ref?: string
  state?: { paths?: string[]; env?: string[] }
  login?: { cmd: string; interactive?: boolean; requires_callback_url?: boolean }
  refresh?: { cmd: string; interval_s?: number }
  expiry?: { parse?: string; grace_s?: number }
}

export interface AgentCliSession {
  mode?: AgentCliSessionMode
  idle_timeout_ms?: number
  max_turns?: number
  context_carryover?: boolean
}

export interface AgentCliModels {
  default?: string
  allowed?: string[]
  env?: Record<string, string>
}

export interface AgentCliCapabilities {
  streaming?: boolean
  tool_calls?: boolean
  sub_agents?: boolean
  file_io?: boolean
  multimodal?: boolean
  resumable?: boolean
  bidirectional?: boolean
}

export interface AgentCliMcpBlock {
  command?: string
  args?: string[]
  transport: "stdio" | "http" | "sse"
  url?: string
}

export interface AgentCliRequires {
  os?: ("darwin" | "linux" | "windows")[]
  arch?: ("x64" | "arm64" | "x86" | "arm")[]
  min_disk_mb?: number
  min_memory_mb?: number
}

export interface AgentCliExample {
  goal: string
  prompt: string
  note?: string
}

export interface AgentCliDefinition {
  name: string
  id: string
  description: string
  version: string
  bin: string
  bin_args?: string[]
  install: AgentCliInstallMethod[]
  version_check: AgentCliVersionCheck
  auth?: AgentCliAuth
  sandbox: string | Record<string, unknown>
  runner?: string | Record<string, unknown>
  protocol: AgentCliProtocol
  /** REQUIRED when protocol=acp. Workspace-relative ref to AIP-44 ACP.md. */
  acp?: string
  /** REQUIRED when protocol=mcp. */
  mcp?: AgentCliMcpBlock
  /** REQUIRED when protocol=proprietary. NPM package implementing AgentCliClient. */
  adapter?: string
  session?: AgentCliSession
  models?: AgentCliModels
  capabilities?: AgentCliCapabilities
  requires?: AgentCliRequires
  examples?: AgentCliExample[]
  tags?: string[]
  metadata?: Record<string, unknown>
}

export type AgentCliHandle = Readonly<AgentCliDefinition>

/**
 * Connection options handed to a protocol arm by the runner. Sandbox
 * resolution + secrets injection happen *before* this point — the arm
 * receives a flat env map and a working dir.
 */
export interface AgentCliConnectOptions {
  cwd: string
  env: Record<string, string>
  abortSignal: AbortSignal
}

/**
 * Per-turn dispatch shape. Implemented by every protocol arm
 * (ACP, MCP, proprietary). The runner is the only call site for
 * these methods; consumers see {@link AgentCliSession} instead.
 */
export interface AgentCliClient {
  connect(opts: AgentCliConnectOptions): Promise<void>
  send(turnId: string, message: unknown): Promise<void>
  events(): AsyncIterable<StreamEvent>
  cancel(turnId: string): Promise<void>
  close(): Promise<void>
}

/**
 * The runtime handle returned by `defineAgentCli` — call `.start()`
 * to spawn the binary and obtain a {@link AgentCliRuntimeSession}.
 */
export interface AgentCliRuntime {
  readonly definition: AgentCliHandle
  start(opts?: AgentCliStartOptions): Promise<AgentCliRuntimeSession>
}

export interface AgentCliStartOptions {
  cwd?: string
  env?: Record<string, string>
  signal?: AbortSignal
}

export interface AgentCliRuntimeSession {
  readonly sessionId: string
  send(message: unknown): AsyncIterable<StreamEvent>
  cancel(): Promise<void>
  close(): Promise<void>
}

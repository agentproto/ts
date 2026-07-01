/**
 * AIP-44 AcpDefinition + AcpHandle.
 *
 * Mirrors `resources/aip-44/draft/ACP.schema.json`. AIP-44 is an
 * agentproto profile of the Agent Client Protocol — top-level fields
 * declare role/transport/version, and AIP-44 extensions live under
 * `metadata.aip44.*`.
 *
 * `AcpHandle` is the readonly view of the same shape; tighten it by
 * hand for fields that get defaults applied in build().
 */

export type AcpRole = "client" | "server" | "bridge"
export type AcpTransport = "stdio" | "websocket"
export type AcpTier = "basic" | "governance-aware" | "sandboxed"

/** Mirror of upstream ACP `initialize` capabilities. */
export interface AcpCapabilities {
  client?: {
    fs?: {
      readTextFile?: boolean
      writeTextFile?: boolean
    }
    terminal?: boolean
  }
  agent?: {
    loadSession?: boolean
    promptCapabilities?: {
      image?: boolean
      audio?: boolean
      embeddedContext?: boolean
    }
    mcpCapabilities?: {
      http?: boolean
      sse?: boolean
    }
  }
}

export interface AcpAuditConfig {
  ref?: string
  kind?: "governance" | "external" | "off"
}

export interface AcpMcpServer {
  name: string
  transport: "stdio" | "http" | "sse"
  ref?: string
}

/** AIP-44 extensions on the agentskills.io baseline. Lives under `metadata.aip44`. */
export interface Aip44Extensions {
  /** Commit SHA of upstream ACP repository this manifest validates against. */
  acp_rev: string
  /** Capability tier shorthand. */
  tier: AcpTier
  /** Optional explicit capability map; overrides tier defaults when present. */
  capabilities?: AcpCapabilities
  /** AIP-9 OPERATOR.md ref. REQUIRED when kind=server. */
  operator?: string
  /** AIP-7 GOVERNANCE.md ref. */
  governance?: string
  /** AIP-36 SANDBOX.md ref. REQUIRED when tier=sandboxed. */
  sandbox?: string
  /** Audit log target override. */
  audit?: AcpAuditConfig
  /** MCP servers to mount via session/new.mcpServers. */
  mcp_servers?: AcpMcpServer[]
  /** AIP-44 extensions stay open; vendors MAY add namespaced sub-keys. */
  [extension: string]: unknown
}

/**
 * AIP-44 ACP.md frontmatter. Top-level fields are stable across upstream
 * ACP rev bumps; the AIP-44-specific binding layer lives in
 * `metadata.aip44`.
 */
export interface AcpDefinition {
  /** Kebab id; MUST equal the parent directory name. */
  name: string
  /** Stable runtime id. */
  id: string
  /** One-paragraph purpose. */
  description: string
  /** Semver of this manifest. */
  version: string
  /** client = drives a subprocess; server = exposes an operator; bridge = both. */
  kind: AcpRole
  /** Transport(s) supported. stdio is REQUIRED; websocket is OPTIONAL. */
  transport: AcpTransport | AcpTransport[]
  /** Free-form metadata. AIP-44 extensions live under `metadata.aip44`. */
  metadata: {
    aip44: Aip44Extensions
    [vendor: string]: unknown
  }
  /** Optional tags for catalog ergonomics. */
  tags?: string[]
  /** Top-level extension surface preserved for forward compatibility. */
  [extension: string]: unknown
}

export type AcpHandle = Readonly<AcpDefinition>

/**
 * Canonical stream-event taxonomy emitted from `createAcpClient`. The
 * client maps upstream ACP `session/update` notifications and
 * `requestPermission` callbacks into this closed set so consumers
 * never see protocol-specific shapes.
 */
export type StreamEvent =
  | { kind: "text-delta"; sessionId: string; text: string }
  | { kind: "tool-call"; sessionId: string; toolCallId: string; toolName: string; arguments: unknown }
  | { kind: "tool-result"; sessionId: string; toolCallId: string; result: unknown; isError?: boolean }
  | { kind: "thought"; sessionId: string; text: string }
  | { kind: "agent-prompt"; sessionId: string; toolCallId: string; options: unknown }
  | {
      kind: "turn-end"
      sessionId: string
      /**
       * `"watchdog-timeout"` is synthesized client-side (never sent by the
       * agent) when `AcpClientOptions.turnIdleTimeoutMs` elapses with no
       * activity signal during a turn and the underlying `prompt()` call
       * still hasn't resolved — distinguishes an inferred completion from
       * a real one so callers that care can tell the difference.
       */
      reason: "completed" | "cancelled" | "max_turns" | "error" | "watchdog-timeout"
    }
  | { kind: "error"; sessionId?: string; error: { code?: number; message: string; data?: unknown } }

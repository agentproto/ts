/**
 * Platform ports: the runtime-owned behavior sentinel consumes without
 * importing `@agentproto/runtime`.
 *
 * Ports are REQUIRED. `@agentproto/runtime` installs its concrete
 * implementations through `configureSentinelPlatform` before any gateway is
 * built, so the daemon's own `gh` runner, durable writer, delivery engine,
 * MCP import reader, provider discovery cache, id minter, lifecycle rules and
 * inbound HMAC check are the ones actually used. Touching a port before it is
 * configured throws a clear "sentinel platform not configured: <port>" error;
 * sentinel never carries a second implementation of a runtime rule.
 */

import type {
  GhRunner,
  MessageKind,
  MessageRelation,
  MessageUrgency,
  PrStatusSnapshot,
  ReviewPrRef,
  SendMessageResult,
  SessionMessage,
  SessionMessageFrom,
} from "./local-types.js"

// ── Durable port shapes (structurally the runtime's durable-file helpers) ──

export interface WriteFileDurableOptions {
  mode?: number
  commitIf?: () => boolean
}

export interface DurableRowFileOptions<Row> {
  filePath: string
  persist: boolean
  debounceMs: number
  log: (line: string) => void
  logPrefix: string
  acceptLoaded: (value: unknown) => readonly [key: string, row: Row] | undefined
}

export interface DurableRowFile<Row> {
  readonly rows: Map<string, Row>
  persistNow(): Promise<void>
  schedulePersist(): void
  settled(): Promise<void>
  flushSync(): void
  insertDurable(
    key: string,
    row: Row,
    retention: { cap: number; oldestTerminalKey: () => string | undefined },
  ): Promise<void>
}

// ── Ports ─────────────────────────────────────────────────────────────────

export interface SentinelGitHubPort {
  execGh: GhRunner
  prRef: (repo: string, number: number) => ReviewPrRef
  fetchPrStatus: (gh: GhRunner, pr: ReviewPrRef, now?: () => Date) => Promise<PrStatusSnapshot>
  parsePrUrl: (url: string) => { repo: string; number: number } | undefined
  PrLookupError: typeof PrLookupError
}

export interface SentinelProviderDiscoveryPort {
  discover: () => Promise<ReadonlyArray<{ slug: string; packageName: string }>>
  probe: (specifier: string) => Promise<Record<string, unknown> | null>
}

export interface ImportedMcpView {
  alias?: string
  snapshot: { headers?: Record<string, string> }
}

export interface SentinelMcpImportsPort {
  loadImportedMcps: () => Promise<{ imports: ImportedMcpView[] }>
}

export interface DeliveryState {
  attempts: number
  lastError?: string
  lastAt?: string
}

export interface DeliveryReplay {
  subId: string
  callbackUrl: string
  secrets: readonly string[]
}

export type DeliveryOutcome =
  | { ok: true; delivery: DeliveryState }
  | { ok: false; reason: string; delivery: DeliveryState }

export type McpEventEnvelope = {
  eventId: string
  name: string
  timestamp: string
  data: Record<string, unknown>
  cursor: string | null
  truncated?: boolean
}

export interface DeliverEventDeps {
  fetch?: (url: string, init: { method?: "POST"; headers?: Record<string, string>; body?: Uint8Array; timeoutMs: number }) => Promise<{ status: number; body: string }>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onAttempt?: (info: { attempt: number; status?: number; error?: string; outcome: "retry" | "delivered" | "dead" }) => void
}

export type InboundSignatureProvider = "agentpush" | "sentinel"

export interface SentinelWebhookDeliveryPort {
  deliverEventEnvelope: (replay: DeliveryReplay, event: McpEventEnvelope, deps?: DeliverEventDeps) => Promise<DeliveryOutcome>
  serializeEnvelope: (event: McpEventEnvelope) => Uint8Array
  callbackHost: (url: string) => string
  redactUrls: (text: string) => string
  verifyInboundSignature: (
    provider: InboundSignatureProvider,
    input: { rawBody: string; headers: Record<string, string | string[] | undefined>; secret: string; nowMs: number },
  ) => { ok: true } | { ok: false; reason: string }
}

export interface SentinelDurablePort {
  writeFileDurable: (filePath: string, data: string, opts?: WriteFileDurableOptions) => Promise<void>
  writeFileDurableSync: (filePath: string, data: string, mode?: number) => void
  appendLineDurableSync: (filePath: string, line: string, mode?: number) => void
  createDurableRowFile: <Row>(opts: DurableRowFileOptions<Row>) => DurableRowFile<Row>
  oldestTerminalKey: <Row>(
    rows: ReadonlyMap<string, Row>,
    isTerminal: (row: Row) => boolean,
    terminalAt: (row: Row) => number,
  ) => string | undefined
}

type CreateMessageInput = {
  to: string
  from: SessionMessageFrom
  text: string
  kind?: MessageKind
  urgency?: MessageUrgency
  replyTo?: string
  correlationId?: string
  data?: Record<string, unknown>
}

export interface SentinelMessagePort {
  createSessionMessage: (input: CreateMessageInput) => SessionMessage
  maxMessageDataBytes: number
  isSessionNotAlive: (err: unknown) => boolean
  urgencies: readonly MessageUrgency[]
}

export interface SentinelIdsPort {
  ulid: (nowMs?: number) => string
}

export interface SentinelLifecyclePort {
  isRetired: (desc: { archived?: boolean; endedReason?: string; continuedTo?: string; retiredAt?: string }) => boolean
  DELIBERATE_END_REASONS: ReadonlySet<string>
  normalizeExpiresAt: (value: unknown) => string | undefined
  isExpiresAtReached: (expiresAt: string | undefined, nowMs: number) => boolean
}

export interface SentinelPlatform {
  github: SentinelGitHubPort
  discovery: SentinelProviderDiscoveryPort
  mcpImports: SentinelMcpImportsPort
  webhookDelivery: SentinelWebhookDeliveryPort
  durable: SentinelDurablePort
  messages: SentinelMessagePort
  ids: SentinelIdsPort
  lifecycle: SentinelLifecyclePort
}

export type PrLookupErrorCode = "gh_unavailable" | "gh_failed" | "unsupported_remote" | "no_pr"

export class PrLookupError extends Error {
  constructor(
    readonly code: PrLookupErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "PrLookupError"
  }
}

let current: Partial<SentinelPlatform> = {}

/** Install the runtime's concrete implementations. Per-port partials merge
 *  over whatever is already installed; a port that is never configured throws
 *  on first access instead of silently using a second implementation. */
export function configureSentinelPlatform(overrides: Partial<SentinelPlatform>): void {
  current = {
    ...current,
    ...overrides,
    github: { ...current.github, ...overrides.github },
    discovery: { ...current.discovery, ...overrides.discovery },
    mcpImports: { ...current.mcpImports, ...overrides.mcpImports },
    webhookDelivery: { ...current.webhookDelivery, ...overrides.webhookDelivery },
    durable: { ...current.durable, ...overrides.durable },
    messages: { ...current.messages, ...overrides.messages },
    ids: { ...current.ids, ...overrides.ids },
    lifecycle: { ...current.lifecycle, ...overrides.lifecycle },
  } as Partial<SentinelPlatform>
}

const platformProxy = new Proxy({} as SentinelPlatform, {
  get(_target, prop: string | symbol) {
    const port = current[prop as keyof SentinelPlatform]
    if (port === undefined) {
      throw new Error(`sentinel platform not configured: ${String(prop)}`)
    }
    return port
  },
})

export function sentinelPlatform(): SentinelPlatform {
  return platformProxy
}

export function resetSentinelPlatform(): void {
  current = {}
}

export type {
  GhRunner,
  MessageKind,
  MessageRelation,
  MessageUrgency,
  PrStatusSnapshot,
  ReviewPrRef,
  SendMessageResult,
  SessionMessage,
  SessionMessageFrom,
}

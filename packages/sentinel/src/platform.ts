/**
 * Platform ports: the runtime-owned behavior sentinel consumes without
 * importing `@agentproto/runtime`.
 *
 * Each port has a standalone default so the package and its tests work on
 * their own. `@agentproto/runtime` installs its concrete implementations
 * (`configureSentinelPlatform`) before creating a gateway, so in production
 * the daemon's own `gh` runner, durable writer, delivery engine, MCP import
 * reader and provider discovery cache are the ones actually used.
 */

import { execFile } from "node:child_process"

import {
  DELIBERATE_END_REASONS,
  MESSAGE_URGENCIES,
  isExpiresAtReached,
  isRetired,
  normalizeExpiresAt,
  type GhRunner,
  type MessageKind,
  type MessageRelation,
  type MessageUrgency,
  type PrStatusSnapshot,
  type ReviewPrRef,
  type SendMessageResult,
  type SessionMessage,
  type SessionMessageFrom,
} from "./local-types.js"
import {
  appendLineDurableSync,
  createDurableRowFile,
  oldestTerminalKey,
  writeFileDurable,
  writeFileDurableSync,
} from "./durable-internal.js"

export interface SentinelGitHubPort {
  execGh: GhRunner
  prRef: (repo: string, number: number) => ReviewPrRef
  fetchPrStatus: (gh: GhRunner, pr: ReviewPrRef, now?: () => Date) => Promise<PrStatusSnapshot>
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

export interface SentinelWebhookDeliveryPort {
  deliverEventEnvelope: (replay: DeliveryReplay, event: McpEventEnvelope, deps?: DeliverEventDeps) => Promise<DeliveryOutcome>
  serializeEnvelope: (event: McpEventEnvelope) => Uint8Array
  callbackHost: (url: string) => string
  redactUrls: (text: string) => string
}

export interface SentinelDurablePort {
  writeFileDurable: typeof writeFileDurable
  writeFileDurableSync: typeof writeFileDurableSync
  appendLineDurableSync: typeof appendLineDurableSync
  createDurableRowFile: typeof createDurableRowFile
  oldestTerminalKey: typeof oldestTerminalKey
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
}

export interface SentinelPlatform {
  github: SentinelGitHubPort
  discovery: SentinelProviderDiscoveryPort
  mcpImports: SentinelMcpImportsPort
  webhookDelivery: SentinelWebhookDeliveryPort
  durable: SentinelDurablePort
  messages: SentinelMessagePort
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

const defaultExecGh: GhRunner = (args) =>
  new Promise((resolvePromise, reject) => {
    execFile("gh", [...args], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === "ENOENT") {
          reject(new PrLookupError("gh_unavailable", "the GitHub CLI (`gh`) is not installed or not on the daemon's PATH"))
          return
        }
        reject(new PrLookupError("gh_failed", `gh ${args.join(" ")} failed: ${String(stderr || err.message).trim()}`))
        return
      }
      resolvePromise(String(stdout))
    })
  })

const defaultPrRef = (repo: string, number: number): ReviewPrRef => ({
  provider: "github",
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
})

async function ghJson<T>(gh: GhRunner, path: string): Promise<T> {
  const out = await gh(["api", "-H", "Accept: application/vnd.github+json", path])
  try {
    return JSON.parse(out) as T
  } catch {
    throw new PrLookupError("gh_failed", `gh api ${path} returned non-JSON output`)
  }
}

interface GhPull {
  number: number
  html_url?: string
  state: "open" | "closed"
  merged_at?: string | null
  head?: { sha?: string; ref?: string }
}

async function defaultFetchPrStatus(gh: GhRunner, pr: ReviewPrRef, now: () => Date = () => new Date()): Promise<PrStatusSnapshot> {
  const pull = await ghJson<GhPull>(gh, `repos/${pr.repo}/pulls/${pr.number}`)
  const rawReviews = await ghJson<Array<{ user?: { login?: string } | null; state?: string; submitted_at?: string }>>(
    gh,
    `repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`,
  )
  let checks: PrStatusSnapshot["checks"]
  if (pull.head?.sha) {
    try {
      const runs = await ghJson<{ check_runs?: Array<{ name?: string; conclusion?: string | null }> }>(
        gh,
        `repos/${pr.repo}/commits/${pull.head.sha}/check-runs?per_page=100`,
      )
      checks = (runs.check_runs ?? []).map((c) => ({ name: String(c.name ?? ""), conclusion: c.conclusion ?? null }))
    } catch {
      checks = undefined
    }
  }
  return {
    fetchedAt: now().toISOString(),
    state: pull.merged_at ? "merged" : pull.state === "open" ? "open" : "closed",
    reviews: (Array.isArray(rawReviews) ? rawReviews : []).map((r) => ({
      login: r.user?.login ?? "",
      state: r.state ?? "",
      submittedAt: r.submitted_at ?? "",
    })),
    ...(checks ? { checks } : {}),
    ...(pull.head?.sha ? { headSha: pull.head.sha } : {}),
    ...(pull.head?.ref ? { headRefName: pull.head.ref } : {}),
  }
}

function defaultCreateSessionMessage(input: CreateMessageInput): SessionMessage {
  const id = `msg_${Math.random().toString(36).slice(2, 10)}`
  const max = 16 * 1024
  if (input.data !== undefined) {
    const bytes = Buffer.byteLength(JSON.stringify(input.data), "utf8")
    if (bytes > max) throw new Error(`message data is ${bytes} bytes — the limit is ${max}`)
  }
  return {
    id,
    ts: new Date().toISOString(),
    to: input.to,
    from: input.from,
    kind: input.kind ?? "report",
    urgency: input.urgency ?? "next-turn",
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    correlationId: input.correlationId ?? input.replyTo ?? id,
    text: input.text,
    ...(input.data !== undefined ? { data: input.data } : {}),
  }
}

function defaultCallbackHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return "invalid-url"
  }
}

function defaultRedactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s'"<>)]+/gi, (m) => {
    try {
      const u = new URL(m)
      return `${u.protocol}//${u.host}`
    } catch {
      return "<url>"
    }
  })
}

function defaultSerializeEnvelope(event: McpEventEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event))
}

const defaults: SentinelPlatform = {
  github: {
    execGh: defaultExecGh,
    prRef: defaultPrRef,
    fetchPrStatus: defaultFetchPrStatus,
    PrLookupError,
  },
  discovery: {
    discover: async () => [],
    probe: async () => null,
  },
  mcpImports: {
    loadImportedMcps: async () => ({ imports: [] }),
  },
  webhookDelivery: {
    deliverEventEnvelope: async () => {
      throw new Error("sentinel webhook delivery port is not configured")
    },
    serializeEnvelope: defaultSerializeEnvelope,
    callbackHost: defaultCallbackHost,
    redactUrls: defaultRedactUrls,
  },
  durable: {
    writeFileDurable,
    writeFileDurableSync,
    appendLineDurableSync,
    createDurableRowFile,
    oldestTerminalKey,
  },
  messages: {
    createSessionMessage: defaultCreateSessionMessage,
    maxMessageDataBytes: 16 * 1024,
    isSessionNotAlive: (err) => err instanceof Error && err.name === "SessionNotAliveError",
  },
}

let current: SentinelPlatform = defaults

/** Install the runtime's concrete implementations. Partial maps merge over
 *  the standalone defaults so a caller can override one port at a time. */
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
  }
}

export function sentinelPlatform(): SentinelPlatform {
  return current
}

export function resetSentinelPlatform(): void {
  current = defaults
}

export { DELIBERATE_END_REASONS, MESSAGE_URGENCIES, isExpiresAtReached, isRetired, normalizeExpiresAt }
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

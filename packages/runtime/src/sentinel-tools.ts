/**
 * MCP surface for the sentinel primitive (AIP-60 §6): `sentinel_watch`,
 * `sentinel_list`, `sentinel_unwatch`, `sentinel_poll_now`.
 *
 * `sentinel_watch`'s `sessionId` defaults to the calling session — same
 * "trusted `?callerSessionId=`" pattern `message-tools.ts` uses — so a
 * session watching its own PR doesn't need to know its own id.
 *
 * Provider auto-select isn't implemented yet (design §6): `provider`
 * defaults to `local-gh`, the only built-in that ships as of this step.
 *
 * `createSentinelWatch`/`cancelSentinelWatch`/`sentinelView` are exported so
 * `http-server.ts`'s `POST/GET/DELETE /sentinels` routes (the daemon-HTTP
 * surface `agentproto sentinel` talks to) share the exact same
 * validation/sugar-resolution logic as this MCP surface — same pattern as
 * `TunnelRegistry` backing both `tunnel_create` and `POST /tunnels`, except
 * here the shared logic is a plain function rather than a stateful registry
 * method, since sentinel creation also needs the provider handle.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { MESSAGE_URGENCIES, type MessageUrgency } from "./session-message.js"
import { parsePrUrl } from "./review-pr.js"
import { GITHUB_DEFAULT_PR_TYPES } from "./sentinel-github-normalize.js"
import { LOCAL_GH_SLUG } from "./sentinel-providers/local-gh.js"
import {
  singleMatch,
  type SentinelHandle,
  type SentinelMatchClause,
  type SentinelProviderHandle,
  type SentinelSpec,
  type SentinelTarget,
  type SentinelUntil,
} from "./sentinel-providers/types.js"
import type { Sentinel, SentinelStatus, SentinelStore } from "./sentinel-store.js"

// ── Shared create/cancel/view (MCP + HTTP) ───────────────────────────────

export interface SentinelWatchInput {
  subject?: string
  prUrl?: string
  sessionId?: string
  types?: string[]
  urgency?: MessageUrgency
  until?: "subject_terminal" | "never"
  provider?: string
}

export interface SentinelWatchDeps {
  store: SentinelStore
  resolveProvider: (slug: string) => Promise<SentinelProviderHandle | null>
  isSessionAlive: (sessionId: string) => boolean
  /** Default `target.sessionId` when `input.sessionId` is omitted (the MCP
   *  caller's own session; HTTP callers have no equivalent and must always
   *  pass `sessionId` explicitly). */
  defaultSessionId?: string
  /** Poll cadence handed to a provider's `create()` as its
   *  `DeliveryPreference`. Default 15s (matches `sentinel-runtime.ts`'s
   *  `activeIntervalMs`). */
  activeIntervalMs?: number
}

export type SentinelWatchResult =
  | { ok: true; sentinel: Sentinel }
  | { ok: false; error: string; message: string }

function resolveUntil(input: "subject_terminal" | "never" | undefined, prSugar: boolean): SentinelUntil {
  if (input === "never") return { kind: "never" }
  if (input === "subject_terminal") return { kind: "subject_terminal" }
  // No explicit `until` — `prUrl` sugar defaults to watching until the PR's
  // terminal event (design §6); a raw `subject` defaults to "never" (the
  // caller presumably wants `sentinel_unwatch` to be the only way out).
  return prSugar ? { kind: "subject_terminal" } : { kind: "never" }
}

/** The shared create path: resolve `prUrl` sugar / a raw `subject`, default
 *  `sessionId`/`until`, resolve the provider, call its `create()`, then
 *  persist the record. Never throws — every failure comes back as
 *  `{ok:false, error, message}` so both an MCP tool result and an HTTP JSON
 *  body can be built from it directly. */
export async function createSentinelWatch(
  deps: SentinelWatchDeps,
  input: SentinelWatchInput,
): Promise<SentinelWatchResult> {
  if (!input.subject && !input.prUrl) {
    return { ok: false, error: "missing_subject", message: "provide either `subject` or `prUrl`" }
  }
  if (input.subject && input.prUrl) {
    return { ok: false, error: "ambiguous_subject", message: "provide only one of `subject` or `prUrl`" }
  }

  let subject: string
  let types = input.types
  const prSugar = input.prUrl !== undefined
  if (input.prUrl) {
    const parsed = parsePrUrl(input.prUrl)
    if (!parsed) {
      return { ok: false, error: "invalid_pr_url", message: `could not parse a github.com PR URL from "${input.prUrl}"` }
    }
    subject = `github:${parsed.repo}#${parsed.number}`
    if (!types) types = [...GITHUB_DEFAULT_PR_TYPES]
  } else {
    subject = input.subject!
  }
  const until = resolveUntil(input.until, prSugar)

  const sessionId = input.sessionId ?? deps.defaultSessionId
  if (!sessionId) {
    return {
      ok: false,
      error: "no_caller_identity",
      message:
        "no `sessionId` given and no calling session identity to default to " +
        "(this needs gateway access attributed to a session, or an explicit sessionId).",
    }
  }
  if (!deps.isSessionAlive(sessionId)) {
    return { ok: false, error: "session_not_alive", message: `session "${sessionId}" is not alive` }
  }

  const providerSlug = input.provider ?? LOCAL_GH_SLUG
  const provider = await deps.resolveProvider(providerSlug)
  if (!provider) {
    return { ok: false, error: "unknown_provider", message: `provider "${providerSlug}" is not available` }
  }

  const spec: SentinelSpec = {
    match: singleMatch(subject, types),
    until,
    target: { kind: "session", sessionId, urgency: input.urgency ?? "next-turn" },
    provider: providerSlug,
  }

  let handle: SentinelHandle
  try {
    handle = await provider.create(spec, { mode: "poll", intervalMs: deps.activeIntervalMs ?? 15_000 })
  } catch (err) {
    return { ok: false, error: "provider_create_failed", message: err instanceof Error ? err.message : String(err) }
  }

  try {
    const sentinel = deps.store.create({ spec, provider: providerSlug, handle })
    return { ok: true, sentinel }
  } catch (err) {
    return { ok: false, error: "create_failed", message: err instanceof Error ? err.message : String(err) }
  }
}

/** The shared stop path: best-effort provider cancel, then remove the
 *  record. `false` only means "no such sentinel" — a failed provider cancel
 *  never blocks the record's removal (a stuck provider-side resource must
 *  not strand `sentinel_unwatch`/`DELETE /sentinels/:id`). */
export async function cancelSentinelWatch(
  deps: Pick<SentinelWatchDeps, "store" | "resolveProvider">,
  id: string,
): Promise<boolean> {
  const sentinel = deps.store.get(id)
  if (!sentinel) return false
  const provider = await deps.resolveProvider(sentinel.provider)
  if (provider) {
    try {
      await provider.cancel(sentinel.handle)
    } catch {
      // Best-effort — see doc comment above.
    }
  }
  deps.store.remove(id)
  return true
}

/** Compact wire view of a sentinel for tool/HTTP results — the internal-only
 *  fields (`handle`, `seen`, `terminalSubjects`) never leave the daemon. */
export interface SentinelView {
  id: string
  provider: string
  status: SentinelStatus
  match: SentinelMatchClause[]
  until: SentinelUntil
  target: SentinelTarget
  group?: string
  label?: string
  createdTs: number
  eventCount: number
  lastEventTs?: number
  lastError?: string
}

export function sentinelView(s: Sentinel): SentinelView {
  return {
    id: s.id,
    provider: s.provider,
    status: s.status,
    match: s.spec.match,
    until: s.spec.until,
    target: s.spec.target,
    ...(s.spec.group ? { group: s.spec.group } : {}),
    ...(s.spec.label ? { label: s.spec.label } : {}),
    createdTs: s.createdTs,
    eventCount: s.eventCount,
    ...(s.lastEventTs !== undefined ? { lastEventTs: s.lastEventTs } : {}),
    ...(s.lastError ? { lastError: s.lastError } : {}),
  }
}

// ── MCP tools ─────────────────────────────────────────────────────────

export interface SentinelRuntimeLike {
  pollOnce(): Promise<void>
}

export interface RegisterSentinelToolsOptions {
  store: SentinelStore
  runtime: SentinelRuntimeLike
  resolveProvider: (slug: string) => Promise<SentinelProviderHandle | null>
  isSessionAlive: (sessionId: string) => boolean
  /** The trusted `?callerSessionId=` of the connecting `/mcp` client — the
   *  default target session for `sentinel_watch` when the caller omits
   *  `sessionId`. Absent for a human/root `/mcp` call. */
  callerSessionId?: string
  /** Poll cadence handed to a provider's `create()` as its
   *  `DeliveryPreference` — matches `sentinel-runtime.ts`'s
   *  `activeIntervalMs`. Default 15s. */
  activeIntervalMs?: number
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

const ok = (body: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ ok: true, ...body }) }],
})
const fail = (code: string, message: string): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ ok: false, error: code, message }) }],
  isError: true,
})

const urgencyField = z.enum(MESSAGE_URGENCIES as [MessageUrgency, ...MessageUrgency[]])
const untilField = z.enum(["subject_terminal", "never"])

export function registerSentinelTools(server: McpServer, opts: RegisterSentinelToolsOptions): void {
  const { store, runtime, resolveProvider, isSessionAlive, callerSessionId, activeIntervalMs } = opts

  server.tool(
    "sentinel_watch",
    "Watch a GitHub subject (a PR, by default) and deliver matching events " +
      "as a `system`/`notice` message into a session's AIP-46 inbox. Provide " +
      "either `prUrl` (sugar: `https://github.com/o/r/pull/N` -> subject " +
      "`github:o/r#N`, the default PR type set, and `until: subject_terminal`) " +
      "or a raw `subject` (e.g. `github:o/r#N`, `github:o/r`). `sessionId` " +
      "defaults to the calling session. `provider` defaults to `local-gh` " +
      "(the only built-in today — zero infra, uses the host's authenticated " +
      "`gh` CLI).",
    {
      subject: z.string().optional().describe("Raw subject, e.g. \"github:owner/repo#42\". Mutually exclusive with prUrl."),
      prUrl: z.string().optional().describe("https://github.com/owner/repo/pull/N — sugar for subject+types+until."),
      sessionId: z.string().optional().describe("Target session. Defaults to the calling session."),
      types: z.array(z.string()).optional().describe("Type globs. Defaults to the provider's defaultTypes(subject)."),
      urgency: urgencyField.optional().describe("Inbox delivery urgency. Default \"next-turn\"."),
      until: untilField.optional().describe("Lifetime. Default \"subject_terminal\" for prUrl, \"never\" for a raw subject."),
      provider: z.string().optional().describe("Provider slug. Default \"local-gh\"."),
    },
    async (input: SentinelWatchInput) => {
      const result = await createSentinelWatch(
        { store, resolveProvider, isSessionAlive, ...(callerSessionId ? { defaultSessionId: callerSessionId } : {}), ...(activeIntervalMs !== undefined ? { activeIntervalMs } : {}) },
        input,
      )
      return result.ok
        ? ok({ sentinel: sentinelView(result.sentinel) })
        : fail(result.error, `sentinel_watch: ${result.message}`)
    },
  )

  server.tool(
    "sentinel_list",
    "List every sentinel this daemon is tracking, with status, match " +
      "clauses, target, and event counters. Credentials are never returned.",
    {},
    async () => ok({ sentinels: store.list().map(sentinelView) }),
  )

  server.tool(
    "sentinel_unwatch",
    "Stop a sentinel: best-effort cancels the provider-side watch, then " +
      "removes the record. Idempotent-ish: an unknown id is reported, not thrown.",
    { id: z.string().describe("Sentinel id (sen_...).") },
    async ({ id }: { id: string }) => {
      const removed = await cancelSentinelWatch({ store, resolveProvider }, id)
      if (!removed) return fail("not_found", `sentinel_unwatch: no sentinel "${id}"`)
      return ok({ removed: true, id })
    },
  )

  server.tool(
    "sentinel_poll_now",
    "Force an immediate poll tick across every poll-capable sentinel " +
      "(there is no per-sentinel targeted poll yet — `id`, when given, only " +
      "selects what's echoed back in the result, not what gets polled).",
    { id: z.string().optional().describe("Echo this sentinel's post-poll state in the result.") },
    async ({ id }: { id?: string }) => {
      if (id && !store.get(id)) return fail("not_found", `sentinel_poll_now: no sentinel "${id}"`)
      await runtime.pollOnce()
      const sentinel = id ? store.get(id) : undefined
      return ok({ polled: true, ...(sentinel ? { sentinel: sentinelView(sentinel) } : {}) })
    },
  )
}

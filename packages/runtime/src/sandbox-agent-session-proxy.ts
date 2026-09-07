/**
 * `AgentSessionLike` proxy over a booted sandbox's OWN agentproto daemon
 * (Option A — see the sandbox-into-agent_start plan). `session-spawn.ts`'s
 * sandbox branch boots the box, calls `host.start()` to run the box's own
 * `agent_start`, and hands the resulting session id here — the registry
 * then treats this proxy exactly like a local adapter's `AgentSessionLike`.
 *
 * `send()` drives the box daemon's session via `agent_prompt`, then
 * subscribes to the box's OWN `GET /sessions/:id/events/stream` SSE
 * endpoint — the same structured event-log records (thought/tool-call/
 * text-delta/turn-end, shaped like `AgentStreamEvent`) a local session's
 * transcript writer produces (`transcript-writer.ts`) — and re-yields them
 * as-is. That shape match is load-bearing: the registry's `runAgentTurn`
 * feeds every yielded event through the SAME transcript-writer +
 * output-ring path it uses for a local session, with no special-casing —
 * so the conversation is captured durably on the HOST side, independent of
 * the (ephemeral) box, WITH full tool-call/usage_update fidelity from the
 * sandboxed adapter (not just flattened text). `agent_output`/`agent_export`
 * keep working after `agent_kill` / box teardown (amendment: conversation
 * survives sandbox teardown).
 *
 * Fallback (documented, not a bug): a box daemon that predates the
 * `/events/stream` route (404) or is simply unreachable degrades this
 * turn to the OLD flattened-text behaviour — polling `agent_output` via
 * `session_monitor`/`agent_prompt`'s ring buffer — rather than failing the
 * turn outright. See `pollAgentOutputFallback`.
 */

import type { SandboxAgentSessionHost, SandboxLifecyclePolicy } from "@agentproto/sandbox"
import type { AgentSessionLike, AgentStreamEvent } from "./sessions.js"

/** `session_monitor`'s max accepted long-poll window (`orchestration-tools.ts`). */
const MAX_POLL_MS = 49_000
/** Pull the full ring-buffer cap each poll so a verbose turn doesn't lose
 *  lines between polls (the ring buffer itself is still capped upstream). */
const MAX_OUTPUT_LINES = 500
/** Give up on the turn only after this many poll failures IN A ROW — a
 *  saturated box (clone + model turn on a small microVM) can stall single
 *  requests past their timeout while the turn itself is healthy. With the
 *  49s window + retry delay this tolerates several minutes of continuous
 *  unreachability before declaring the box dead. */
const MAX_CONSECUTIVE_POLL_FAILURES = 6
/** Pause between failed polls — no tight error loop against a sick box. */
const POLL_RETRY_DELAY_MS = 5_000

/** Record `kind`s the box's transcript writer produces FROM an adapter's
 *  own stream (`transcript-writer.ts`'s `recordEvent` switch) — the exact
 *  set a local session's `send()` can yield. Other on-disk kinds
 *  (`user-prompt`, `system-prompt`, `tool-call-record`, `usage_snapshot`)
 *  are synthesized by the WRITER itself from other call sites, never by
 *  `send()`, so they're skipped rather than re-yielded here. */
const STREAM_EVENT_RECORD_KINDS = new Set([
  "text-delta",
  "thought",
  "tool-call",
  "tool-result",
  "agent-prompt",
  "permission-resolved",
  "turn-end",
  "notice",
  "error",
  "plan",
  "usage_update",
  "available-commands",
])

export interface SandboxAgentSessionProxyOpts {
  /** The booted sandbox's daemon host. `prompt`/`output`/`kill`/`waitForAny`
   *  drive the box's OWN `agent_start` session; `stop()`/`pause()` tear the
   *  box down (closes the daemon connection, then stops/pauses the
   *  sandbox) — `pause` is only present when the booted sandbox supports
   *  it (see `BootedSandbox.pause`). `mcpUrl` is the box daemon's own HTTP
   *  origin — reused (not a second client) to reach its
   *  `/sessions/:id/events/stream` route alongside the MCP endpoint. */
  host: Pick<
    SandboxAgentSessionHost,
    | "prompt"
    | "output"
    | "kill"
    | "waitForAny"
    | "currentEventsCursor"
    | "stop"
    | "pause"
    | "mcpUrl"
  >
  /** Session id on the BOX's own daemon (from `host.start(...)`) — NOT this
   *  proxy's local session id (the registry mints its own on `spawnAgent`). */
  remoteSessionId: string
  /** PR3 AIP-36 lifecycle policy (`resolveLifecyclePolicy`) — decides
   *  whether `close()` pauses the box (reuse-friendly) or kills it
   *  (ephemeral, the default). Omitted ⇒ always kill, matching PR2. */
  lifecyclePolicy?: SandboxLifecyclePolicy
}

/**
 * Best-effort extraction of the prompt text from whatever `sessions.ts`'s
 * `runAgentTurn` hands `AgentSessionLike.send()` — today always either a
 * bare string, or the ACP-style `{type:"text", text}` block `runAgentTurn`
 * wraps a string message into before calling `send()`.
 */
function extractPromptText(message: unknown): string {
  if (typeof message === "string") return message
  if (message && typeof message === "object" && "text" in message) {
    const text = (message as { text?: unknown }).text
    if (typeof text === "string") return text
  }
  return JSON.stringify(message)
}

/** Build the box daemon's own `GET /sessions/:id/events/stream` URL —
 *  same host:port as `mcpUrl` (the daemon's HTTP server serves both), just
 *  a different path. `since` is the PER-SESSION transcript seq to resume
 *  after — a different cursor space than `currentEventsCursor()`'s
 *  daemon-wide event-bus cursor (that one feeds `session_monitor`, this
 *  one feeds the session's own `events.jsonl`). */
function buildEventsStreamUrl(mcpUrl: string, remoteSessionId: string, since: number): string {
  const url = new URL(mcpUrl)
  url.pathname = `/sessions/${encodeURIComponent(remoteSessionId)}/events/stream`
  url.search = `since=${since}`
  return url.toString()
}

/**
 * Open the box daemon's structured SSE stream. Throws (caller falls back to
 * `pollAgentOutputFallback`) when the box is unreachable or its daemon
 * predates the route (404) — the ONLY case this proxy degrades on, per the
 * module doc.
 */
async function openBoxEventStream(
  mcpUrl: string,
  remoteSessionId: string,
  since: number,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const url = buildEventsStreamUrl(mcpUrl, remoteSessionId, since)
  const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal })
  if (!res.ok || !res.body) {
    throw new Error(`sandbox proxy: GET ${url} returned ${res.status}`)
  }
  return res.body
}

/**
 * Parse `GET /sessions/:id/events/stream`'s `data: <json>\n\n` frames off
 * an already-open SSE body — same framing the CLI's own SSE consumers
 * parse (`cli/src/commands/sessions.ts`'s dashboard `/events` reader).
 * `:`-prefixed comment lines (the route's `: connected`/`: keep-alive`
 * pings) are not `data:` lines and fall out of the filter naturally.
 */
async function* readSseRecords(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += decoder.decode(value, { stream: true })
      let idx = buf.indexOf("\n\n")
      while (idx !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue
          const payload = line.slice("data:".length).trim()
          if (!payload) continue
          try {
            yield JSON.parse(payload) as Record<string, unknown>
          } catch {
            // Malformed frame — tolerate, same as the CLI's own SSE readers.
          }
        }
        idx = buf.indexOf("\n\n")
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/**
 * Map an `events.jsonl` record back onto the `AgentStreamEvent` shape
 * `send()` must yield — the inverse of `transcript-writer.ts`'s
 * `recordEvent`, which writes these records FROM an `AgentStreamEvent` in
 * the first place, so every field beyond the bookkeeping ones
 * (`seq`/`ts`/`sessionId`/the debounce-only `partial` marker) carries over
 * unchanged. Returns `undefined` for record kinds `send()` never yields
 * (`user-prompt`, `system-prompt`, `tool-call-record`, `usage_snapshot` —
 * synthesized by the writer's OTHER methods, not `recordEvent`) or for a
 * malformed/unrecognized record.
 */
function recordToStreamEvent(record: Record<string, unknown>): AgentStreamEvent | undefined {
  const kind = record.kind
  if (typeof kind !== "string" || !STREAM_EVENT_RECORD_KINDS.has(kind)) return undefined
  const { seq: _seq, ts: _ts, sessionId: _sessionId, partial: _partial, ...rest } = record
  return { ...rest, kind } as AgentStreamEvent
}

/**
 * Legacy fallback: flatten the box's `agent_output` ring-buffer tail into
 * plain text-delta events, exactly as this proxy did before the structured
 * SSE stream existed. Used only when `openBoxEventStream` fails — a box
 * daemon whose `/sessions/:id/events/stream` route 404s (predates it) or
 * is simply unreachable — so a fresh/older box still degrades gracefully
 * instead of failing the turn (see module doc).
 */
async function* pollAgentOutputFallback(
  host: Pick<SandboxAgentSessionHost, "output" | "waitForAny">,
  remoteSessionId: string,
  since: number,
): AsyncGenerator<AgentStreamEvent> {
  // The offset is a character offset into the raw joined string — NOT a
  // line count. `projectEvent`'s text-delta handling expects
  // newline-delimited STREAM FRAGMENTS it coalesces itself (partial lines
  // included); re-splitting the tail into whole lines here and yielding
  // each separately (with the splitting newline stripped) would feed it
  // back newline-less chunks that get glued into one mangled line instead.
  // Yielding the raw new suffix (embedded newlines intact) lets that same
  // coalescing logic split it correctly.
  let seenLength = 0
  try {
    // Transient-failure tolerance: a single failed poll request must NOT
    // kill the turn. A long review turn saturates a small box (monorepo
    // clone + model generation), stalling its daemon's event loop past the
    // client's per-request timeout — `MCP error -32001` — while the turn
    // itself is perfectly healthy (observed in CI, ~2min in). Each poll is
    // a bounded request, but the TURN is the loop: retry after a short
    // pause, and only give up after MAX_CONSECUTIVE_POLL_FAILURES in a row
    // (a genuinely dead/unreachable box still errors, with the last
    // failure's message).
    let consecutivePollFailures = 0
    for (;;) {
      let result: Awaited<ReturnType<typeof host.waitForAny>>
      try {
        // `since` (reused unchanged across retries — a timeout means
        // nothing has matched since that cursor yet, so there's nothing to
        // advance) is what makes this race-free; the subscription timing
        // itself no longer matters.
        result = await host.waitForAny([remoteSessionId], {
          event: "any",
          timeoutMs: MAX_POLL_MS,
          since,
        })
        consecutivePollFailures = 0
      } catch (pollErr) {
        consecutivePollFailures++
        if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          throw new Error(
            `sandbox proxy: ${consecutivePollFailures} consecutive poll failures against the ` +
              `box daemon (session "${remoteSessionId}") — giving up. Last error: ` +
              `${pollErr instanceof Error ? pollErr.message : String(pollErr)}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_RETRY_DELAY_MS))
        continue
      }
      // A clean long-poll timeout carries no `event` at all — keep polling
      // past it instead of mistaking it for a real settle (mirrors
      // `@agentproto/worktree`'s `waitForSettled`).
      if (result.timedOut) continue

      // The tail pull is best-effort: the offset-based diff means a failed
      // pull loses nothing — a later successful pull (or the catch's final
      // harvest below) yields the full unseen suffix. One immediate retry,
      // then proceed without it rather than killing a settled turn over a
      // missed output read.
      let tail: string | undefined
      try {
        tail = await host.output(remoteSessionId, MAX_OUTPUT_LINES)
      } catch {
        try {
          tail = await host.output(remoteSessionId, MAX_OUTPUT_LINES)
        } catch {
          tail = undefined
        }
      }
      if (tail !== undefined && tail.length > seenLength) {
        yield { kind: "text-delta", text: tail.slice(seenLength) }
      }
      if (tail !== undefined) seenLength = tail.length

      if (result.event === "exited") {
        // The box's OWN session ended out-of-band (crash, OOM, an
        // independent kill) — not a normal turn boundary. Throwing here
        // (rather than yielding a turn-end) lets the registry's existing
        // `runAgentTurn` catch flip this session's status to "error" and
        // emit `session:exited`, the same "proxy detects remote exit"
        // behaviour a local adapter crash gets today — no new plumbing.
        throw new Error(
          `sandbox proxy: remote session "${remoteSessionId}" exited — the box's own ` +
            "agentproto daemon ended this session (crash, OOM, or an out-of-band kill).",
        )
      }
      yield {
        kind: "turn-end",
        reason: result.event === "awaiting-input" ? "awaiting-input" : "completed",
      }
      return
    }
  } catch (err) {
    // Final harvest before the error propagates: pull whatever the box
    // printed that this turn hasn't yielded yet, so the HOST transcript
    // and ring buffer carry the box session's last words (stack traces,
    // adapter stderr, partial thoughts). Without this, a failure between
    // polls — or a thrown `host.prompt`/`waitForAny` — left the host side
    // EMPTY and post-mortem diagnosis blind (observed in CI: a box session
    // erroring ~2min in with zero surfaced output). Best-effort: the box
    // may already be unreachable.
    try {
      const tail = await host.output(remoteSessionId, MAX_OUTPUT_LINES)
      if (tail.length > seenLength) {
        yield { kind: "text-delta", text: tail.slice(seenLength) }
      }
    } catch {
      // box gone — nothing more to salvage
    }
    throw err
  }
}

/**
 * Build an `AgentSessionLike` over a box daemon's own `agent_start` session.
 * See module docs for the structured-stream/fallback split and the
 * cancel-semantics note below.
 */
export function createSandboxAgentSessionProxy(
  opts: SandboxAgentSessionProxyOpts,
): AgentSessionLike {
  const { host, remoteSessionId, lifecyclePolicy } = opts
  let lastPrompt: string | undefined
  let closed = false
  // This session's own transcript-seq cursor — a DIFFERENT space than
  // `currentEventsCursor()`'s daemon-wide event-bus cursor (that one feeds
  // `session_monitor`; this one feeds `GET /sessions/:id/events/stream`).
  // Starts at 0: `host.start()` never sends a prompt of its own
  // (`session-spawn.ts` calls it with no `prompt`), so the very first
  // `send()` call is this session's first turn and there is no prior
  // transcript to skip. Advanced to the last consumed record's `seq` after
  // every turn (in the closure, so it persists across turns) so a later
  // turn's stream only replays what's new — no extra round-trip needed to
  // discover "current tip" the way `currentEventsCursor()` does for the
  // bus, since nothing else writes to THIS session's transcript
  // concurrently.
  let transcriptCursor = 0

  return {
    sessionId: remoteSessionId,

    async *send(message: unknown): AsyncIterable<AgentStreamEvent> {
      const prompt = extractPromptText(message)
      lastPrompt = prompt

      // Capture a race-free cursor BEFORE sending: an extremely fast turn
      // (a synchronous/near-instant adapter echo is plausible for a
      // trivial prompt) can settle and fire its `session:turn-end` before
      // `waitForAny`'s own long-poll request even reaches the box daemon
      // over the network — client-side call ORDERING alone can't close
      // this (two outbound HTTP requests racing to the same daemon have no
      // guaranteed arrival order). The awaited cursor fetch completes
      // strictly before `prompt` is sent, so the box daemon's ring-replay
      // branch (`orchestration-tools.ts`'s `monitorSessionWait`) always
      // finds the matching turn-end regardless of how late the long-poll's
      // bus subscription lands — see `HarnessClient.currentEventsCursor`'s
      // doc. Only consumed by `pollAgentOutputFallback` below, but always
      // captured up front (mirrors `@agentproto/worktree`'s
      // `sendPromptAndWait`, which uses the same cursor-first pattern)
      // so a mid-turn fallback never starts from a stale cursor.
      const since = await host.currentEventsCursor()
      await host.prompt(remoteSessionId, prompt)

      const controller = new AbortController()
      let sseBody: ReadableStream<Uint8Array> | undefined
      try {
        sseBody = await openBoxEventStream(
          host.mcpUrl,
          remoteSessionId,
          transcriptCursor,
          controller.signal,
        )
      } catch {
        // Unreachable box, or a daemon old enough to 404 the route —
        // degrade to the flattened poll rather than failing the turn.
        sseBody = undefined
      }

      if (!sseBody) {
        yield* pollAgentOutputFallback(host, remoteSessionId, since)
        return
      }

      try {
        let sawTurnEnd = false
        for await (const record of readSseRecords(sseBody)) {
          if (typeof record.seq === "number") transcriptCursor = record.seq
          const evt = recordToStreamEvent(record)
          if (!evt) continue
          yield evt
          if (evt.kind === "turn-end") {
            sawTurnEnd = true
            break
          }
        }
        if (!sawTurnEnd) {
          // The connection closed (box HTTP server gone, not just the
          // adapter subprocess) without a terminal turn-end record ever
          // landing. The box's OWN `runAgentTurn` guarantees a turn-end
          // (real or synthesized) for any outcome it can observe — a
          // stream that ends without one means the box daemon itself
          // stopped observing, i.e. it's gone. Throwing here mirrors the
          // fallback path's "exited" handling: the registry's
          // `runAgentTurn` catch flips this session's status to "error"
          // and emits `session:exited`.
          throw new Error(
            `sandbox proxy: structured event stream for remote session "${remoteSessionId}" ` +
              "ended without a turn-end — the box's own agentproto daemon connection was " +
              "lost (crash, OOM, or an out-of-band kill).",
          )
        }
      } catch (err) {
        // Best-effort final harvest, same rationale as the legacy fallback's
        // catch: pull whatever the box printed that this turn hasn't
        // yielded as a structured event, so the HOST transcript isn't left
        // blind. May overlap with content already yielded above — an
        // acceptable duplicate on an already-abnormal turn, not a silent
        // gap.
        try {
          const tail = await host.output(remoteSessionId, MAX_OUTPUT_LINES)
          if (tail) yield { kind: "text-delta", text: tail }
        } catch {
          // box gone — nothing more to salvage
        }
        throw err
      } finally {
        controller.abort()
      }
    },

    async cancel(): Promise<void> {
      // There is no bare "interrupt, no next prompt" primitive on the wire
      // — `agent_prompt` always carries a prompt. Re-deliver the last
      // prompt with `interrupt: true`, cancelling the in-flight turn and
      // restarting it on the same session (a documented limitation: a
      // cancel before any prompt was sent, or a race with a fresh prompt,
      // has nothing/the wrong thing to redeliver).
      if (lastPrompt === undefined) return
      await host.prompt(remoteSessionId, lastPrompt, { interrupt: true })
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      try {
        await host.kill(remoteSessionId)
      } finally {
        // PAUSE (not kill) when the lifecycle policy says this box is
        // meant to be reused later — falls back to `stop()` when the
        // provider never exposed a `pause()` (e.g. `local`, or a policy
        // that resolved to "pause" against a non-pausable provider): a
        // teardown must never silently no-op and leak the box.
        if (lifecyclePolicy?.teardown === "pause" && host.pause) {
          await host.pause()
        } else {
          await host.stop()
        }
      }
    },
  }
}

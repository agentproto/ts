/**
 * `AgentSessionLike` proxy over a booted sandbox's OWN agentproto daemon
 * (Option A — see the sandbox-into-agent_start plan). `session-spawn.ts`'s
 * sandbox branch boots the box, calls `host.start()` to run the box's own
 * `agent_start`, and hands the resulting session id here — the registry
 * then treats this proxy exactly like a local adapter's `AgentSessionLike`.
 *
 * `send()` drives the box daemon's session via `agent_prompt` +
 * `session_monitor` + `agent_output`, and flattens the result into the same
 * `AgentStreamEvent` shape the local adapter path yields (text-delta lines
 * plus a terminal turn-end). That shape match is load-bearing: the
 * registry's `runAgentTurn` feeds every yielded event through the SAME
 * transcript-writer + output-ring path it uses for a local session, with no
 * special-casing — so the conversation is captured durably on the HOST
 * side, independent of the (ephemeral) box. `agent_output`/`agent_export`
 * keep working after `agent_kill` / box teardown (amendment: conversation
 * survives sandbox teardown).
 *
 * Known limitation (documented, not fixed here): this flattens the box's
 * structured events into plain text lines — tool-call/usage_update
 * fidelity from the SANDBOXED adapter is lost (usage accounting, tool-call
 * visibility). Follow-up work can subscribe to the box daemon's SSE
 * `/sessions/:id/stream` instead of polling `agent_output`.
 */

import type { SandboxAgentSessionHost, SandboxLifecyclePolicy } from "@agentproto/sandbox"
import type { AgentSessionLike, AgentStreamEvent } from "./sessions.js"

/** `session_monitor`'s max accepted long-poll window (`orchestration-tools.ts`). */
const MAX_POLL_MS = 49_000
/** Pull the full ring-buffer cap each poll so a verbose turn doesn't lose
 *  lines between polls (the ring buffer itself is still capped upstream —
 *  see the module doc's known-limitation note). */
const MAX_OUTPUT_LINES = 500
/** Give up on the turn only after this many poll failures IN A ROW — a
 *  saturated box (clone + model turn on a small microVM) can stall single
 *  requests past their timeout while the turn itself is healthy. With the
 *  49s window + retry delay this tolerates several minutes of continuous
 *  unreachability before declaring the box dead. */
const MAX_CONSECUTIVE_POLL_FAILURES = 6
/** Pause between failed polls — no tight error loop against a sick box. */
const POLL_RETRY_DELAY_MS = 5_000

export interface SandboxAgentSessionProxyOpts {
  /** The booted sandbox's daemon host. `prompt`/`output`/`kill`/`waitForAny`
   *  drive the box's OWN `agent_start` session; `stop()`/`pause()` tear the
   *  box down (closes the daemon connection, then stops/pauses the
   *  sandbox) — `pause` is only present when the booted sandbox supports
   *  it (see `BootedSandbox.pause`). */
  host: Pick<
    SandboxAgentSessionHost,
    "prompt" | "output" | "kill" | "waitForAny" | "currentEventsCursor" | "stop" | "pause"
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

/**
 * Build an `AgentSessionLike` over a box daemon's own `agent_start` session.
 * See module docs for the event-fidelity limitation and the cancel-
 * semantics note below.
 */
export function createSandboxAgentSessionProxy(
  opts: SandboxAgentSessionProxyOpts,
): AgentSessionLike {
  const { host, remoteSessionId, lifecyclePolicy } = opts
  let lastPrompt: string | undefined
  let closed = false

  return {
    sessionId: remoteSessionId,

    async *send(message: unknown): AsyncIterable<AgentStreamEvent> {
      const prompt = extractPromptText(message)
      lastPrompt = prompt
      // Tracks how much of the box's `agent_output` tail this turn has
      // already yielded — declared OUTSIDE the try so the catch's final
      // harvest below can yield only the unseen suffix.
      let seenLength = 0
      try {
        // Capture a race-free cursor BEFORE sending: an extremely fast turn
        // (a synchronous/near-instant adapter echo is plausible for a
        // trivial prompt) can settle and fire its `session:turn-end` before
        // `waitForAny`'s own long-poll request even reaches the box daemon
        // over the network — client-side call ORDERING alone can't close
        // this (two outbound HTTP requests racing to the same daemon have
        // no guaranteed arrival order). The awaited cursor fetch completes
        // strictly before `prompt` is sent, so the box daemon's ring-replay
        // branch (`orchestration-tools.ts`'s `monitorSessionWait`) always
        // finds the matching turn-end regardless of how late the long-poll's
        // bus subscription lands — see `HarnessClient.currentEventsCursor`'s
        // doc. Mirrors `@agentproto/worktree`'s `sendPromptAndWait`, which
        // uses the same cursor-first pattern for its own prompt+wait path.
        const since = await host.currentEventsCursor()
        await host.prompt(remoteSessionId, prompt)

      // The offset is a character offset into the raw joined string — NOT a
      // line count. `projectEvent`'s text-delta handling expects
      // newline-delimited STREAM FRAGMENTS it coalesces itself (partial
      // lines included); re-splitting the tail into whole lines here and
      // yielding each separately (with the splitting newline stripped)
      // would feed it back newline-less chunks that get glued into one
      // mangled line instead. Yielding the raw new suffix (embedded
      // newlines intact) lets that same coalescing logic split it
      // correctly. Known limitation (documented in the module doc): if
      // the box's ring buffer evicts lines from the front between polls,
      // this offset can go stale — acceptable for the turn sizes this
      // flattening path targets; a real fix subscribes to the box's SSE
      // stream instead of polling a bounded tail.
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
          // nothing has matched since that cursor yet, so there's nothing
          // to advance) is what makes this race-free; the subscription
          // timing itself no longer matters.
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
        // A clean long-poll timeout carries no `event` at all — keep
        // polling past it instead of mistaking it for a real settle
        // (mirrors `@agentproto/worktree`'s `waitForSettled`).
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
        // polls — or a thrown `host.prompt`/`waitForAny` — left the host
        // side EMPTY and post-mortem diagnosis blind (observed in CI: a box
        // session erroring ~2min in with zero surfaced output). Best-effort:
        // the box may already be unreachable.
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

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

import type { SandboxAgentSessionHost } from "@agentproto/sandbox"
import type { AgentSessionLike, AgentStreamEvent } from "./sessions.js"

/** `session_monitor`'s max accepted long-poll window (`orchestration-tools.ts`). */
const MAX_POLL_MS = 49_000
/** Pull the full ring-buffer cap each poll so a verbose turn doesn't lose
 *  lines between polls (the ring buffer itself is still capped upstream —
 *  see the module doc's known-limitation note). */
const MAX_OUTPUT_LINES = 500

export interface SandboxAgentSessionProxyOpts {
  /** The booted sandbox's daemon host. `prompt`/`output`/`kill`/`waitForAny`
   *  drive the box's OWN `agent_start` session; `stop()` tears the whole
   *  box down (closes the daemon connection, then stops the sandbox). */
  host: Pick<SandboxAgentSessionHost, "prompt" | "output" | "kill" | "waitForAny" | "stop">
  /** Session id on the BOX's own daemon (from `host.start(...)`) — NOT this
   *  proxy's local session id (the registry mints its own on `spawnAgent`). */
  remoteSessionId: string
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
  const { host, remoteSessionId } = opts
  let lastPrompt: string | undefined
  let closed = false

  return {
    sessionId: remoteSessionId,

    async *send(message: unknown): AsyncIterable<AgentStreamEvent> {
      const prompt = extractPromptText(message)
      lastPrompt = prompt
      await host.prompt(remoteSessionId, prompt)

      // Tracks how much of the box's `agent_output` tail this turn has
      // already yielded, as a character offset into the raw joined string
      // — NOT a line count. `projectEvent`'s text-delta handling expects
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
      let seenLength = 0
      for (;;) {
        const result = await host.waitForAny([remoteSessionId], {
          event: "any",
          timeoutMs: MAX_POLL_MS,
        })
        // A clean long-poll timeout carries no `event` at all — keep
        // polling past it instead of mistaking it for a real settle
        // (mirrors `@agentproto/worktree`'s `waitForSettled`).
        if (result.timedOut) continue

        const tail = await host.output(remoteSessionId, MAX_OUTPUT_LINES)
        if (tail.length > seenLength) {
          yield { kind: "text-delta", text: tail.slice(seenLength) }
        }
        seenLength = tail.length

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
        await host.stop()
      }
    },
  }
}

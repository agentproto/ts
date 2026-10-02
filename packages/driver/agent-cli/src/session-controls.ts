/**
 * Live-session control surface, built once from a connected protocol arm.
 *
 * `AgentCliRuntimeSession` requires six members beyond
 * `send`/`cancel`/`close`: the three mid-session switches (`setModel`,
 * `setSessionMode`, `setEffort`, SPEC §3.9/§3.4a) and the three
 * read-surface snapshots (`availableConfigOptions`, `availableModes`,
 * `currentModeId`). All six are pure delegation to the arm — none of
 * them touch the child process, the spawn, or the transport.
 *
 * They used to live inline inside `createAgentCliRuntime`, which made
 * them unreachable for any host that builds its OWN session over a
 * different transport. Those hosts exist and are the whole point of
 * `createAcpProtocolArm` being exported: guilde runs one runtime whose
 * child lives in an e2b sandbox and another whose child lives on a
 * remote daemon behind a WS tunnel, both driving the same ACP arm. Every
 * such host had to hand-copy this block, and silently broke the day the
 * interface grew a seventh member.
 *
 * So it lives here, exported, and `createAgentCliRuntime` consumes it
 * like everyone else — one implementation, one place to extend.
 */

import { randomUUID } from "node:crypto"
import type {
  AgentCliClient,
  AgentCliHandle,
  AgentCliRuntimeSession,
  SetModelResult,
  StreamEvent,
} from "./types.js"

/**
 * The slice of `AgentCliRuntimeSession` {@link createArmSessionControls}
 * supplies. Spread it into the session literal alongside the
 * transport-specific `sessionId`/`send`/`cancel`/`close`.
 */
export type ArmSessionControls = Pick<
  AgentCliRuntimeSession,
  | "setModel"
  | "setSessionMode"
  | "setEffort"
  | "availableConfigOptions"
  | "availableModes"
  | "currentModeId"
>

/**
 * Build the control surface from a CONNECTED arm.
 *
 * Call this after `arm.connect()` has resolved: the read-surface fields
 * are snapshots, so an ACP arm's captured `newSession`/`loadSession`
 * response has to already be populated. Arms that don't model this
 * (print, proprietary) leave the getters undefined and are defaulted
 * here to the same empty/absent shape their `setModel`-style
 * counterparts use for "not supported".
 *
 * Every switch resolves — none throws, none tears down the session, even
 * when the underlying agent rejects the request. See
 * {@link SetModelResult} and friends for the reason vocabulary.
 */
export function createArmSessionControls(
  arm: AgentCliClient,
  definition: AgentCliHandle,
): ArmSessionControls {
  const modelApply = definition.models?.apply ?? "config"

  return {
    // Capability read-surface (SPEC §3.9/§3.4a) — snapshotted once
    // `arm.connect()` has resolved. Not live-updated by a later
    // `setModel`/`setSessionMode` call.
    availableConfigOptions: arm.availableConfigOptions ?? [],
    availableModes: arm.availableModes ?? [],
    currentModeId: arm.currentModeId,

    /**
     * Mid-session model switch — the runtime counterpart to the
     * spawn-time model apply. Dispatches on the same
     * `definition.models.apply` strategy so a live switch behaves
     * exactly like the spawn-time apply would have, just against an
     * already-running session.
     */
    async setModel(modelId: string): Promise<SetModelResult> {
      if (modelApply === "arg") {
        // This CLI takes its model as a spawn-time argv token
        // (bin_args_template, composed once before spawn) — there is
        // no live surface to change it against a running session.
        return { applied: false, reason: "requires-restart" }
      }
      if (modelApply === "command") {
        return applyModelCommand(arm, modelId)
      }
      // "config" (default): apply via the arm's setConfigOption, which
      // only the ACP arm implements — other arms (print, proprietary)
      // simply don't have a mid-session config surface.
      if (!arm.setConfigOption) {
        return { applied: false, reason: "not-supported" }
      }
      const result = await arm.setConfigOption("model", modelId)
      return result.applied
        ? { applied: true, model: modelId }
        : { applied: false, ...(result.reason ? { reason: result.reason } : {}) }
    },

    /**
     * Mid-session posture switch — the native-mode counterpart to
     * `setModel`, wired directly to the arm's `setSessionMode` (only the
     * ACP arm implements it).
     */
    async setSessionMode(modeId: string) {
      if (!arm.setSessionMode) {
        return { applied: false, reason: "not-supported" }
      }
      const result = await arm.setSessionMode(modeId)
      return result.applied
        ? { applied: true, modeId }
        : { applied: false, ...(result.reason ? { reason: result.reason } : {}) }
    },

    /**
     * Mid-session effort switch — the effort-axis counterpart to
     * `setModel`'s `"config"` strategy, wired to the same
     * `arm.setConfigOption` surface with `configId:"effort"`. Best-effort:
     * an effort label the current model rejects resolves
     * `{applied:false, reason}` (SPEC risk R7).
     */
    async setEffort(effort: string) {
      if (!arm.setConfigOption) {
        return { applied: false, reason: "not-supported" }
      }
      const result = await arm.setConfigOption("effort", effort)
      return result.applied
        ? { applied: true, effort }
        : { applied: false, ...(result.reason ? { reason: result.reason } : {}) }
    },
  }
}

/**
 * Loose acknowledgement match shared by `applyModelCommand`'s dedicated
 * control turn below AND the ordinary-prompt learn-path
 * (`@agentproto/runtime`'s `sessions.ts` `runAgentTurn`, which watches a
 * plain `/model <id>` typed as a normal conversational turn — the shape the
 * hermes spawn recipe's `/model` shortcut actually sends today, since it
 * never goes through this control turn). Hermes replies "Model switched to:
 * <id> · Provider: …"; other adapters phrase it differently, so this is
 * deliberately lax rather than coupled to one adapter's wording or a
 * specific `StreamEvent` shape.
 *
 * REPORTED BY THE ADAPTER, NOT INDEPENDENTLY VERIFIED — good enough as a
 * display hint (`SessionDescriptor.activeModel`), never as a source of
 * billing/cost truth. A caller that ever reads `activeModel` for cost
 * purposes must know it read a heuristic, not a fact.
 */
export const MODEL_SWITCH_ACK_RE = /switch|model\s+set|now using/i

/** See {@link MODEL_SWITCH_ACK_RE}. */
export function isModelSwitchAcknowledgement(evt: unknown): boolean {
  return MODEL_SWITCH_ACK_RE.test(JSON.stringify(evt))
}

/**
 * Extract the target model id from a plain-text turn that opens with a
 * `/model <id>` control command — whether it arrives through
 * `applyModelCommand`'s dedicated control turn or as an ORDINARY
 * conversational prompt (see {@link MODEL_SWITCH_ACK_RE}'s doc for why the
 * latter matters: it's the case the hermes spawn recipe actually produces).
 */
export function parseModelSwitchCommand(text: string): string | undefined {
  return /^\s*\/model\s+(\S+)/i.exec(text)?.[1]
}

/**
 * Switch the active model via a `/model <id>` control turn, for adapters
 * whose ACP session config doesn't select the model (`models.apply:
 * "command"`, e.g. hermes). The turn is fully drained so the switch
 * completes before the caller's next real turn. Best-effort: a transport
 * failure or a missing acknowledgement is warned and reported as
 * `{applied:false, reason}`, never thrown — the session simply continues
 * on whatever model it already had. Shared by the spawn-time apply
 * (return value ignored there) and the mid-session `setModel("command")`
 * path (return value surfaced to the caller).
 */
export async function applyModelCommand(
  arm: AgentCliClient,
  modelId: string,
): Promise<SetModelResult> {
  const turnId = randomUUID()
  let acked = false
  try {
    for await (const evt of promptTurn(arm, turnId, {
      type: "text",
      text: `/model ${modelId}`,
    })) {
      if (isModelSwitchAcknowledgement(evt)) acked = true
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(
      `[agent-cli] /model ${modelId} control turn failed (continuing on default):`,
      err instanceof Error ? err.message : err,
    )
    return { applied: false, reason }
  }
  if (!acked) {
    const reason = "no switch acknowledgement — agent may be on its default model"
    console.warn(`[agent-cli] /model ${modelId}: ${reason}`)
    return { applied: false, reason }
  }
  return { applied: true, model: modelId }
}

/**
 * Parse a single `key=value` logfmt line into a flat map. Values may be
 * bare (`small=false`) or double-quoted (`message="stream error"`,
 * `error.error="AI_APICallError: …"`); a quoted value's inner `\"` / `\\`
 * escapes are unescaped. Deliberately tiny — this only ever reads
 * opencode's structured stderr log lines, not a general logfmt corpus.
 */
function parseLogfmtLine(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z0-9_.-]+)=("(?:[^"\\]|\\.)*"|\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    const key = m[1]!
    let value = m[2]!
    if (value.startsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
    }
    out[key] = value
  }
  return out
}

/**
 * Strip a leading error-class prefix off a provider error string so the
 * operator sees the human reason, not the class: `"AI_APICallError: Go
 * usage limit exceeded"` → `"Go usage limit exceeded"`. A message with no
 * recognizable `…Error:` / `…Exception:` prefix is returned verbatim.
 */
function providerMessageFromError(raw: string): string {
  const m = raw.match(/^[A-Za-z_][\w.]*(?:Error|Exception)\s*:\s*([\s\S]+)$/)
  return (m ? m[1]! : raw).trim()
}

/**
 * Parse an opencode-style logfmt stderr line into the provider error it
 * reports, or `undefined` when the line is not a turn-fatal provider
 * error.
 *
 * opencode's ACP server treats a provider 429 / usage-cap as retryable and
 * loops internally; it logs the reason ONLY to stderr — e.g.
 *
 *   timestamp=2026-10-02T12:20:59.007Z level=ERROR run=f897ee16 \
 *     message="stream error" providerID=opencode-go modelID=glm-5.3-flash \
 *     session.id=ses_x small=false agent=build \
 *     error.error="AI_APICallError: Go usage limit exceeded"
 *
 * — while `session/prompt` never resolves, so the daemon sees a silent,
 * 0-token, busy session forever. Surfacing that line as the turn's error
 * is what turns the hang into a readable failure. `agent=title` /
 * `small=true` lines are opencode's background title generator and MUST
 * NOT fail the user's turn, so they are ignored.
 */
export function parseStderrStreamError(line: string): string | undefined {
  if (!line.includes("stream error")) return undefined
  const fields = parseLogfmtLine(line)
  if ((fields.level ?? "").toUpperCase() !== "ERROR") return undefined
  if (fields.message !== "stream error") return undefined
  if (fields.small === "true") return undefined
  if (fields.agent === "title") return undefined
  const raw = fields["error.error"] ?? fields.error
  if (!raw) return undefined
  return providerMessageFromError(raw)
}

/**
 * Send a turn and yield the arm's events for it.
 *
 * Re-attaches the recent stderr tail to error events. The ACP layer
 * surfaces a terse `{message: "Invalid params"}`; the child's stderr
 * almost always has a more useful line ("npx claude-agent-acp: not
 * authenticated, run `claude login`"). Hosts read `error.data` when
 * present, falling back to `message` for older payloads.
 *
 * When `stderrTurnError` is supplied, a line it parses into a message
 * (see {@link parseStderrStreamError}) is surfaced as THIS turn's error:
 * the turn is cancelled and ended with `reason:"error"` instead of hanging
 * forever on a `prompt` the server never resolves. Only armed for adapters
 * whose transport retries silently (opencode); every other adapter keeps
 * the exact prior behavior.
 */
export async function* promptTurn(
  arm: AgentCliClient,
  turnId: string,
  message: unknown,
  stderrTurnError?: (line: string) => string | undefined,
): AsyncIterable<StreamEvent> {
  const stderrTail = arm._stderrTail

  // Subscribe BEFORE `send` so a provider error logged while the prompt is
  // being dispatched isn't missed. The parser filters for turn-fatal lines
  // only (title-generator noise is dropped inside it).
  const pendingErrors: string[] = []
  let wake: (() => void) | undefined
  const unsubscribe =
    stderrTurnError && arm._onStderrLine
      ? arm._onStderrLine(line => {
          const parsed = stderrTurnError(line)
          if (parsed === undefined) return
          pendingErrors.push(parsed)
          wake?.()
          wake = undefined
        })
      : undefined

  let iterator: AsyncIterator<StreamEvent> | undefined
  try {
    await arm.send(turnId, message)
    iterator = arm.events()[Symbol.asyncIterator]()
    while (true) {
      if (pendingErrors.length > 0) {
        // The provider error only exists on stderr and the server is stuck
        // retrying — stop it and end the turn with the reason.
        await arm.cancel(turnId).catch(() => {})
        yield {
          kind: "error",
          sessionId: arm.sessionId,
          error: {
            message: pendingErrors.join("\n"),
            data: { stderr: stderrTail?.() ?? "" },
          },
        }
        yield {
          kind: "turn-end",
          sessionId: arm.sessionId ?? "",
          reason: "error",
        }
        return
      }
      const nextEvent = iterator.next()
      const stderrArrived = new Promise<void>(resolve => {
        wake = resolve
      })
      const winner = await Promise.race([
        nextEvent.then(result => ({ source: "event" as const, result })),
        stderrArrived.then(() => ({ source: "stderr" as const })),
      ])
      if (winner.source === "stderr") continue
      if (winner.result.done) return
      const evt = winner.result.value
      if (evt.kind === "error" && typeof stderrTail === "function") {
        const tail = stderrTail()
        if (tail) {
          const existing = (evt.error.data ?? {}) as Record<string, unknown>
          evt.error.data = { ...existing, stderr: tail }
        }
      }
      yield evt
    }
  } finally {
    unsubscribe?.()
    // Release the underlying prompt stream best-effort. Never awaited: a
    // server still stuck in its internal retry loop may not settle the
    // pending `next()`, and blocking teardown on that would reintroduce
    // the very hang this path exists to break.
    void iterator?.return?.()?.catch?.(() => {})
  }
}

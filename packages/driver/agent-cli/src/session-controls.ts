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
      // Loose check across the serialised event — hermes replies
      // "Model switched to: <id> · Provider: …". We don't couple to a
      // specific StreamEvent shape; any "switch" mention = acknowledged.
      if (/switch|model\s+set|now using/i.test(JSON.stringify(evt))) acked = true
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
 * Send a turn and yield the arm's events for it.
 *
 * Re-attaches the recent stderr tail to error events. The ACP layer
 * surfaces a terse `{message: "Invalid params"}`; the child's stderr
 * almost always has a more useful line ("npx claude-agent-acp: not
 * authenticated, run `claude login`"). Hosts read `error.data` when
 * present, falling back to `message` for older payloads.
 */
export async function* promptTurn(
  arm: AgentCliClient,
  turnId: string,
  message: unknown,
): AsyncIterable<StreamEvent> {
  await arm.send(turnId, message)
  const stderrTail = arm._stderrTail
  for await (const evt of arm.events()) {
    if (evt.kind === "error" && typeof stderrTail === "function") {
      const tail = stderrTail()
      if (tail) {
        const existing = (evt.error.data ?? {}) as Record<string, unknown>
        evt.error.data = { ...existing, stderr: tail }
      }
    }
    yield evt
  }
}

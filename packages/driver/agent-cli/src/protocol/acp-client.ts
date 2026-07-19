/**
 * AIP-45 protocol arm: `protocol: "acp"`.
 *
 * Wraps a subprocess's stdio in an `@agentproto/acp` client and
 * exposes the `AgentCliClient` shape the runner consumes. Each
 * `send()` call delegates to a single AcpClientSession.prompt() and
 * forwards the resulting StreamEvent stream.
 */

import type { ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import {
  createAcpClient,
  type AcpClient,
  type AcpClientSession,
  type AcpPermissionResolution,
} from "@agentproto/acp/client"
import type {
  AgentCliClient,
  AgentCliConnectOptions,
  StreamEvent,
} from "../types.js"

/**
 * Outcome the host returns to the agent on a permission request.
 *
 * Mirrors the upstream ACP `RequestPermissionResponse` shape EXACTLY —
 * note the doubly-nested `outcome` field: the outer is the response
 * envelope, the inner is the discriminator (string literal, not a
 * `{ type: ... }` object). Get this wrong and the agent silently
 * interprets the response as a refusal ("User refused permission to
 * run tool"), so we type it strictly here.
 *
 *   { outcome: { outcome: "selected", optionId: "..." } }
 *   { outcome: { outcome: "cancelled" } }
 */
export type AcpPermissionOutcome =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } }

export interface AcpPermissionRequestParams {
  sessionId?: string
  // `title`/`kind` allow `null` (not just `undefined`) so the upstream ACP
  // `RequestPermissionRequest` — whose `toolCall` is a `ToolCallUpdate` with
  // `title: string | null` / `kind: ToolKind | null` — is structurally
  // assignable to this shape. That lets the arm's handler take the SDK type
  // directly, with no `as` cast at the `createAcpClient` call site.
  toolCall?: {
    toolCallId?: string
    title?: string | null
    kind?: string | null
    rawInput?: unknown
  }
  options?: Array<{ optionId: string; name?: string; kind?: string }>
}

export type AcpPermissionHandler = (
  params: AcpPermissionRequestParams
) => Promise<AcpPermissionOutcome> | AcpPermissionOutcome

/**
 * Default handler: pick the first option whose `kind` starts with
 * `allow_` (Claude Code offers `allow_once` and `allow_always`).
 * Falls back to the first option if none match — keeps the agent
 * unblocked rather than throwing on an unfamiliar option set.
 *
 * Mirrors the trust model of in-process Mastra agents: the user
 * approved the operator binding once; subsequent tool calls don't
 * re-prompt by default. Hosts that want explicit per-call gating
 * pass their own `onPermissionRequest`.
 *
 * NOT safe to use as-is for a `mode: "plan"` session — see
 * `planModePermissionHandler` below.
 */
export const autoAllowPermissionHandler: AcpPermissionHandler = ({
  options,
}) => {
  if (!options || options.length === 0) {
    // No options offered — return cancelled so the agent gets a
    // deterministic answer instead of hanging on a dropped request.
    return { outcome: { outcome: "cancelled" } }
  }
  const allow =
    options.find(o => typeof o.kind === "string" && o.kind.startsWith("allow_")) ??
    options[0]
  return { outcome: { outcome: "selected", optionId: allow!.optionId } }
}

/**
 * `toolCall.kind` Claude Code's ACP wrapper attaches to the "ready to
 * code?" permission request it raises when the agent wants to leave
 * plan mode (its internal `ExitPlanMode` tool, mapped by
 * `@agentclientprotocol/claude-agent-acp`'s `toolInfoFromToolUse`).
 * This is the ONLY reliable discriminator for that request — its
 * `options[].kind` values (`allow_always` / `allow_once` / `reject_once`)
 * are the same vocabulary an ordinary tool-permission request uses, so
 * `option.kind` alone can't tell the two apart.
 */
const PLAN_MODE_EXIT_TOOL_CALL_KIND = "switch_mode"

/**
 * Permission handler for a session spawned with `mode: "plan"`.
 *
 * `autoAllowPermissionHandler` picks the first `allow_*` option, but for
 * the plan-mode-exit request that option is always an escalation away
 * from plan (`auto`, `acceptEdits`, or `bypassPermissions` depending on
 * what the wrapper offers) — auto-approving it silently defeats the
 * mode the caller asked for (see the regression this fixes: a `plan`
 * session that wrote a file when prompted to). Noted as a known gap in
 * a naive auto-allow handler when #143 shipped the `CLAUDE_CONFIG_DIR`
 * override that makes `mode: "plan"` take effect in the first place;
 * this closes it.
 *
 * Behaves exactly like `autoAllowPermissionHandler` for every other
 * request. For the plan-mode-exit request specifically, it selects the
 * offered `reject_once` option ("No, keep planning") so the wrapper
 * denies the exit with a clean, structured outcome — the tool call
 * fails, the agent stays in plan mode and can keep reasoning or tell
 * the user it's blocked, instead of the turn throwing on a `cancelled`
 * outcome. Falls back to `cancelled` if no `reject_once` option is
 * offered (shouldn't happen with the current wrapper, but a safe
 * default beats guessing an allow).
 *
 * This is a deliberate one-way gate: a plan-mode session driven by this
 * handler can never escalate itself out of plan mode. A caller that
 * wants a human (or a policy engine) to approve that escalation must
 * supply its own `onPermissionRequest` — this handler is only the
 * default for callers that don't.
 */
export const planModePermissionHandler: AcpPermissionHandler = params => {
  const { options, toolCall } = params
  if (!options || options.length === 0) {
    return { outcome: { outcome: "cancelled" } }
  }
  if (toolCall?.kind === PLAN_MODE_EXIT_TOOL_CALL_KIND) {
    const keepPlanning = options.find(o => o.kind === "reject_once")
    return keepPlanning
      ? { outcome: { outcome: "selected", optionId: keepPlanning.optionId } }
      : { outcome: { outcome: "cancelled" } }
  }
  return autoAllowPermissionHandler(params)
}

/** Picks the safe default permission handler for a requested AIP-45
 *  mode when the caller didn't supply their own `onPermissionRequest`.
 *  Only `"plan"` gets special handling today — other modes (accept-edits,
 *  bypass-permissions) are already at-or-above the auto-allow handler's
 *  trust level, so there's no escalation for it to guard against. */
function defaultPermissionHandlerForMode(
  requestedMode: string | undefined,
): AcpPermissionHandler {
  return requestedMode === "plan"
    ? planModePermissionHandler
    : autoAllowPermissionHandler
}

export interface AcpProtocolOptions {
  child: ChildProcess
  cwd: string
  clientInfo?: { name: string; title?: string; version?: string }
  /** Called when the agent asks for permission to run a tool (Write,
   *  Bash, ...). Defaults to `autoAllowPermissionHandler`, or
   *  `planModePermissionHandler` when `requestedMode === "plan"`. Pass a
   *  custom handler to plumb requests through a UI / governance
   *  policy. Throwing or returning a rejected promise bubbles to the
   *  agent as an internal error. */
  onPermissionRequest?: AcpPermissionHandler
  /**
   * AIP-45 mode requested at spawn (`opts.config.mode` in
   * `define-agent-cli.ts`'s `start()`), if any. Used to pick the default
   * permission handler when `onPermissionRequest` is omitted — see
   * `defaultPermissionHandlerForMode`.
   */
  requestedMode?: string
  /**
   * When true, permission requests are surfaced as `agent-prompt` StreamEvents
   * and HELD in the daemon's permission inbox rather than auto-answered —
   * forwarded verbatim to `createAcpClient({ permissionHold })`. The
   * `onPermissionRequest` / `requestedMode` handler is bypassed while this is
   * set. Default false (unchanged: requests are auto-answered in-arm).
   */
  permissionHold?: boolean
}

export function createAcpProtocolArm(
  options: AcpProtocolOptions,
): AgentCliClient {
  const { child, cwd } = options

  if (!child.stdin || !child.stdout) {
    throw new Error(
      "AcpProtocolArm: subprocess must be spawned with piped stdin + stdout",
    )
  }

  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>

  let client: AcpClient | null = null
  let session: AcpClientSession | null = null
  const pendingByTurn = new Map<string, AsyncIterable<StreamEvent>>()

  return {
    get sessionId(): string | undefined {
      return session?.sessionId
    },
    get availableConfigOptions() {
      return session?.availableConfigOptions ?? []
    },
    get availableModes() {
      return session?.availableModes ?? []
    },
    get currentModeId(): string | undefined {
      return session?.currentModeId
    },
    async connect(opts: AgentCliConnectOptions) {
      const permissionHandler =
        options.onPermissionRequest ??
        defaultPermissionHandlerForMode(options.requestedMode)
      client = await createAcpClient({
        output,
        input,
        clientInfo: options.clientInfo,
        capabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
        onActivity: opts.onActivity,
        turnIdleTimeoutMs: opts.turnIdleTimeoutMs,
        // Permission-hold mode: surface + park requests for the daemon inbox
        // instead of auto-answering them in-arm (see AcpProtocolOptions).
        ...(options.permissionHold ? { permissionHold: true } : {}),
        // Wire the permission handler so the agent's `session/request_permission`
        // callbacks get a real answer instead of bubbling up as
        // "AcpClient.requestPermission: no handler configured" → which
        // surfaces in the chat as an opaque "Internal error" when the
        // agent tries to Write / Bash anything gated.
        // `params` is contextually typed as the SDK's `RequestPermissionRequest`
        // (via `AcpClientOptions.handlers`), which is assignable to
        // `AcpPermissionRequestParams` — so no cast is needed on either side.
        handlers: {
          requestPermission: async params => permissionHandler(params),
        },
      })
      // When the host hands us a `resumeSessionId`, reattach to the
      // agent's existing session via `loadSession` so the conversation
      // (model context, tool history, working files) carries over a
      // cold start. We trust the host to only send ids it persisted
      // from a prior turn; if the agent's `loadSession: true` capability
      // wasn't advertised the SDK call surfaces the per-protocol error.
      //
      // No silent fallback to `newSession` on resume failure — that
      // would create a new session quietly and lose continuity, which
      // is the bug we're trying to prevent. Let the error propagate.
      if (opts.resumeSessionId) {
        session = await client.loadSession({
          sessionId: opts.resumeSessionId,
          cwd,
          mcpServers: opts.mcpServers,
        })
      } else {
        session = await client.newSession({
          cwd,
          mcpServers: opts.mcpServers,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(opts.mode ? { mode: opts.mode } : {}),
        })
      }
    },
    async send(turnId, message) {
      if (!session) throw new Error("AcpProtocolArm.send: not connected")
      // ACP's `prompt` field is `ContentBlock[]` — multiple blocks
      // together form the user's turn (text + image + resource_link
      // + ...). Callers MAY pass either:
      //   - a single block (`{type:"text",text:"..."}`) — wrapped
      //     into a one-element array for the wire
      //   - an array of blocks — forwarded verbatim, supporting
      //     multimodal turns without callers re-shaping per-arm
      const messages = Array.isArray(message) ? message : [message]
      const stream = session.prompt({ messages })
      pendingByTurn.set(turnId, stream)
    },
    async *events(): AsyncIterable<StreamEvent> {
      const last = Array.from(pendingByTurn.values()).at(-1)
      if (!last) return
      for await (const evt of last) yield evt
    },
    async cancel(_turnId) {
      if (!session) return
      await session.cancel()
    },
    async setConfigOption(configId, value) {
      // No connected session yet — nothing to apply against. Distinct from
      // `not-supported` (a protocol-level absence): this arm DOES support
      // it, there's just no live connection right now.
      if (!session) return { applied: false, reason: "not-connected" }
      return session.setConfigOption(configId, value)
    },
    async setSessionMode(modeId) {
      // Same not-connected/not-supported split as setConfigOption above.
      if (!session) return { applied: false, reason: "not-connected" }
      return session.setSessionMode(modeId)
    },
    respondPermission(
      requestId: string,
      resolution: AcpPermissionResolution,
    ): boolean {
      // Resolve a permission request parked by permission-hold mode. Routed
      // through the client (its pending map is keyed globally by request id).
      return client?.respondPermission(requestId, resolution) ?? false
    },
    async close() {
      if (session) await session.close()
      if (client) await client.close()
    },
  }
}

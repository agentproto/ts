/**
 * MCP tools that expose agent-CLI lifecycle operations to clients.
 * Extracted from session-tools.ts as the "agent family" module.
 *
 * Lets a remote operator spawn and drive agent CLIs on the user's
 * machine through the same MCP connection they already use for fs/exec.
 *
 * Tools:
 *   agent_start   spawn a long-running agent (claude / hermes / …)
 *   agent_prompt  send a follow-up turn to a live session
 *   agent_output  tail the ring buffer
 *   agent_kill    SIGTERM the session
 *   agent_interrupt   cancel the in-flight turn, leave the session alive
 *   agent_set_model   switch a live session's model without restarting
 *   agent_set_effort  switch a live session's reasoning/compute budget
 *   agent_set_posture switch a live session's posture (native mode)
 *   agent_export  export a clean transcript
 *   agent_sessions_list   browse alive + recent agent sessions
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { AcpMcpServer } from "@agentproto/acp"
import { catchErrors, pageParamsShape, paginated } from "@agentproto/tool"
import { registerBuiltinTool } from "@agentproto/mcp-server"
import type { SessionsRegistry, SessionDescriptor } from "./sessions.js"
import {
  exportAgentSession,
  type ExportAgentSessionInput,
  type ExportAgentSessionResult,
} from "./transcript-export.js"
import type {
  AgentAdapterResolver,
  AgentAdapterLister,
  AgentAdapterInstaller,
  CatalogModelsLister,
  AdapterCapabilitiesLister,
  AdapterListEntry,
} from "./http-server.js"
import { agentStartInputShape, mcpBool } from "./agent-start-schema.js"
import type { OrchestratorScope } from "./orchestrator-gateway.js"
import type { WebhookNotifier } from "./webhook-notifier.js"
import { spawnAgentSession, cleanAgentLines } from "./session-spawn.js"
import type { CompletionPolicySupervisor } from "./supervisor.js"
import { parsePostureInput } from "./canonical-posture.js"
import { getUserPreset } from "./user-presets.js"
import { listRoles, spawnableRolesFor } from "./role.js"
import type { RoleProfile } from "./role.js"
import { loadDefaultRoleRegistry } from "./role-registry.js"
import { buildCatalogProviderModels } from "./catalog-provider-models.js"
import type { CatalogProviderModel } from "./catalog-provider-models.js"
import type { CatalogRoute } from "./catalog-models.js"
import type { SandboxMode } from "@agentproto/command-sandbox"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"
import type {
  WorktreeIsolationMode,
  WorktreeProvisioner,
} from "./worktree-isolation.js"
import { appUiToolId } from "./app-ui-apps.js"
import {
  createSessionMessage,
  messageFrom,
  MESSAGE_KINDS,
  MESSAGE_URGENCIES,
  type MessageKind,
  type MessageUrgency,
} from "./session-message.js"
import { defaultUrgencyForKind, registerMessageTools } from "./message-tools.js"
import { SESSION_CHAT_APP_ID } from "@agentproto/apps"

/** Strip CSI/SGR ANSI escape sequences and bare carriage returns.
 *
 * Removes:
 * - CSI/SGR sequences (\x1b[...): cursor movement, colors, etc.
 * - Bare \r (carriage return not followed by \n): within each line, keeps only text after the last \r
 *   This handles the case where bash echoes pasted content with \r as line separator,
 *   which would otherwise create visible duplication when the \r is rendered (moves cursor to column 0).
 *
 * Exported for test access. */
export function stripAnsi(s: string): string {
  // First remove CSI sequences
  let result = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

  // Then handle bare \r (carriage return) characters:
  // Normalize line endings: \r\n becomes just \n (so CRLF is treated as a single line ending)
  result = result.replace(/\r\n/g, "\n")

  // Now for any remaining bare \r within lines (between \n), keep only text after the last \r.
  // This simulates terminal behavior where \r resets to column 0.
  const lines = result.split("\n")
  result = lines
    .map(line => {
      const parts = line.split("\r")
      return parts[parts.length - 1]
    })
    .join("\n")

  return result
}


// ── session-id argument aliasing ──────────────────────────────────────────
// `agent_start` returns the session as `{ "id": "sess_…" }`, but the drive
// tools (`agent_prompt` / `agent_output` / `agent_kill`) historically took
// `sessionId`. Passing the natural `{ id }` shape back therefore failed with a
// Zod error, forcing a failed call per tool to learn the field name. These
// tools now accept EITHER field (additive, back-compat): `sessionId` stays the
// documented primary; `id` is a first-class alias so an agent can pipe
// `agent_start`'s return straight through.
const sessionIdField = z
  .string()
  .optional()
  .describe(
    "Session id (as returned by agent_start). Accepts either `sessionId` or " +
      "its alias `id` — pass whichever you have.",
  )
const sessionIdAliasField = z
  .string()
  .optional()
  .describe("Alias for `sessionId` — the `id` field returned by agent_start.")

/** Coalesce the `sessionId` / `id` alias pair. */
function resolveSessionIdArg(input: {
  sessionId?: string
  id?: string
}): string | undefined {
  return input.sessionId ?? input.id
}

/** Uniform error when neither `sessionId` nor `id` was supplied. */
function missingSessionIdError(tool: string): {
  content: { type: "text"; text: string }[]
  isError: true
} {
  return {
    content: [
      {
        type: "text",
        text: `${tool}: missing session id — pass \`sessionId\` (or its alias \`id\`).`,
      },
    ],
    isError: true,
  }
}

export interface RegisterAgentToolsOptions {
  registry: SessionsRegistry
  /** Optional adapter resolver — required for `agent_start`
   *  (the others work with raw spawn sessions too). When unset the
   *  start tool returns a clear error pointing at the host wiring. */
  resolveAgentAdapter?: AgentAdapterResolver
  /** Optional adapter lister — when wired, exposes `adapter_list`
   *  MCP tool. Without it the tool returns a clear "not configured"
   *  error pointing at the host wiring. */
  listAgentAdapters?: AgentAdapterLister
  /** Optional harness capability-discovery lister — when wired, exposes
   *  `harness_capabilities` MCP tool. Without it the tool returns a clear
   *  "not configured" error pointing at the host wiring. */
  listHarnessCapabilities?: AdapterCapabilitiesLister
  /** Optional adapter installer — when wired, exposes `adapter_install`
   *  MCP tool (install a not-yet-installed harness by slug). Without it
   *  the tool returns a clear "not configured" error pointing at the host
   *  wiring. */
  installAgentAdapter?: AgentAdapterInstaller
  /** Optional catalog lister — when wired, exposes the read-only
   *  `catalog_models` MCP tool (SPEC §5). Without it the tool returns a
   *  clear "not configured" error pointing at the host wiring. */
  listCatalogModels?: CatalogModelsLister
  /** The daemon's own plain `/mcp` gateway URL (e.g.
   *  `http://127.0.0.1:18790/mcp`). When set, `agent_start` with no
   *  caller-supplied `mcpServers` defaults to mounting this gateway for
   *  the adapters in `shouldInjectDaemonSelfMount` (session-spawn.ts):
   *  hermes (capability — it has zero built-in tools, so omitting
   *  `mcpServers` silently produced a chat-only session) and on-host
   *  claude-code (identity — the injected entry carries
   *  `callerSessionId=<own id>` and shadows the ambient unstamped
   *  project/global mount of the same name, so the session's spawns
   *  auto-attach instead of landing as anonymous orphans). An explicit
   *  `mcpServers: []` is still respected as a deliberate opt-out.
   *  Omitted → no default. */
  daemonMcpUrl?: string
  /** Optional orchestrator-injection builder (WP3). When wired, the
   *  `orchestrator` field on `agent_start` mints a scoped
   *  sub-gateway token, builds the `mcpServers` entry pointing the
   *  child at `/mcp/orchestrator?scope=<token>`, and returns a
   *  `bindLifecycle` hook the handler calls (with the spawned session
   *  id) so the token is revoked when that session exits. Closed over
   *  the gateway's scope-token registry + HTTP port + session-event
   *  bus in `createGateway`. Omitted → `orchestrator` is rejected with
   *  a clear "not enabled" error. */
  buildOrchestratorMcp?: (opts: {
    tools?: readonly string[]
    /** Caller orchestrator scope (WP4) — when a child orchestrator
     *  spawns its OWN sub-orchestrator, the new token inherits depth+1
     *  and is bounded by the caller's tools (non-re-grant). */
    caller?: OrchestratorScope
    /** Override max depth for the minted child scope (clamped to the
     *  caller's, then HARD_MAX_DEPTH). */
    maxDepth?: number
    /** Override the child quota for the minted child scope (clamped to
     *  the caller's). */
    maxChildren?: number
  }) => {
    entry: AcpMcpServer
    bindLifecycle: (sessionId: string) => () => void
  }
  /** Calling orchestrator's scope (orchestrator WP4). Present ONLY on
   *  the scoped sub-gateway server (built per-request from a verified
   *  scope-token), absent on the root `/mcp` server. When present it is
   *  the identity of the orchestrator driving these tools, so:
   *    - spawns are attributed (`parentSessionId = ownerSessionId`,
   *      `depth = depth + 1`) and gated by the depth cap + child quota;
   *    - `agent_sessions_list`/`agent_kill` are restricted to the caller's
   *      subtree.
   *  Absent → full visibility, depth-0 spawns, no parent (today's root
   *  behaviour). */
  callerScope?: OrchestratorScope
  /** Daemon-derived id of the session driving THIS `/mcp` request, parsed from
   *  the trusted `?callerSessionId=` query the self-ref `mcpServers` URL
   *  carries (PR 7 / Gap 7). On the plain `/mcp` path (no `callerScope`) it is
   *  the implicit auto-parent: a spawn made by this session attaches under it
   *  by default (see `spawn-attach.ts`), so a supervisor's executors nest
   *  instead of orphaning. Absent → no auto-parent (attribution falls back to
   *  an explicit `parentSessionId` hint, if any). */
  callerSessionId?: string
  /** The connecting client's source label from this `/mcp` request's `?origin=`
   *  query (#session-visibility) — cowork/vscode/codex/cron. Used as the
   *  DEFAULT `origin` for an `agent_start` that doesn't pass its own, so a
   *  spawn made by a non-session bridge client is attributed to its channel
   *  instead of landing as a bare top-level root. An explicit `input.origin`
   *  always wins. This is the daemon side of the auto-stamp the `agent_start`
   *  schema advertises. */
  mcpBridgeOrigin?: string
  /** Optional webhook notifier — when provided, per-session `notifyUrl`
   *  values from `agent_start` are registered on spawn and
   *  unregistered on exit via the session-event bus. */
  webhookNotifier?: WebhookNotifier
  /** Loads the custom (pack-carried) role registry — forwarded to
   *  `spawnAgentSession` (gates `agent_start`) and used directly by
   *  `role_list` (the introspection-only mirror of the same data), so
   *  the two can never disagree. Defaults to `loadDefaultRoleRegistry()`
   *  (`~/.agentproto/roles/` + adapter-carried packs) when omitted;
   *  tests inject a stub registry to avoid touching the real
   *  filesystem. */
  loadRoleRegistry?: () => Promise<Record<string, RoleProfile>>
  /** Resolves an `agent_start.sandbox` slug (or an inline spec's own
   *  `.provider`) to a concrete sandbox provider handle — forwarded to
   *  `spawnAgentSession`. Omitted → `sandbox` is rejected with
   *  `sandbox_provider_not_found`. */
  resolveSandboxProvider?: SandboxProviderResolver
  /** Provision a git worktree for an `agent_start.worktree` spawn — forwarded
   *  to `spawnAgentSession`. Injected at the composition root by a host that
   *  depends on `@agentproto/worktree` (the CLI). Omitted → a spawn the policy
   *  says to isolate is rejected with `worktree_provisioner_not_enabled`. */
  provisionWorktree?: WorktreeProvisioner
  /** Resolves the `worktrees.isolation` policy — forwarded to
   *  `spawnAgentSession`. Omitted → it reads `~/.agentproto/config.json`
   *  (env > config > `on-request`) itself. */
  resolveWorktreeIsolation?: () => Promise<WorktreeIsolationMode>
  /** Completion-policy supervisor (phase 4). When wired, an `agent_start`
   *  carrying `costBudget` auto-attaches a windowed cost-budget governance
   *  policy on the spawned session (`gate: { costBudget }`, `then: "emit"`) so
   *  the cap is evaluated at every turn-end. Omitted → the budget is still
   *  recorded on the session, but nothing auto-evaluates it (a caller can
   *  attach the same gate by hand via `policy_attach`). */
  supervisor?: CompletionPolicySupervisor
  /** Daemon default for `interrupt` when an `agent_prompt` / `message_parent`
   *  call leaves it UNSET — resolved from config.json's
   *  `defaults.agentPromptInterrupt` at the composition root (index.ts). An
   *  EXPLICIT `interrupt` on the call (true OR false) always wins. Omitted ⇒
   *  treated as `false` (today's queue-behind-the-turn behaviour). */
  defaultAgentPromptInterrupt?: boolean
  /** Whether the `@agentik/session-chat` studio app is installed with a
   *  `ui` block — same check `builtin-apps.ts` uses to decide whether to
   *  mount the loopback-HTTP `agentproto_session_chat` launcher at all.
   *  Threaded here so `agent_start`'s `_meta.ui.resourceUri` (its
   *  auto-render binding) can point straight at the native MCP Apps tool
   *  (`ui://app_ui_session_chat/view`) once it exists, instead of the
   *  loopback launcher a strict-CSP host (Codex) can't fetch. Omitted →
   *  binds to the legacy `ui://agentproto_session_chat/view`, today's
   *  behaviour. */
  isSessionChatInstalled?: () => boolean
  /** config.json `defaults.messaging.allowSiblings` — lets `message_send` /
   *  `message_reply` reach a sibling (same parent). Default false. */
  messagingAllowSiblings?: boolean
  /** config.json `defaults.messaging.agentInterrupt` — whether a SESSION
   *  sender's `urgency: "interrupt"` (or `message_parent`'s `interrupt:
   *  true`) may cancel the recipient's turn. Default "deny": downgraded to
   *  `steer`. Human (HTTP/CLI) senders always keep interrupt. */
  messagingAgentInterrupt?: "allow" | "deny"
}

export function registerAgentTools(
  server: McpServer,
  opts: RegisterAgentToolsOptions
): void {
  const {
    registry,
    resolveAgentAdapter,
    listAgentAdapters,
    listHarnessCapabilities,
    installAgentAdapter,
    listCatalogModels,
    buildOrchestratorMcp,
    callerScope,
    callerSessionId,
    mcpBridgeOrigin,
    webhookNotifier,
    daemonMcpUrl,
    loadRoleRegistry,
    resolveSandboxProvider,
    provisionWorktree,
    resolveWorktreeIsolation,
    supervisor,
    defaultAgentPromptInterrupt,
    isSessionChatInstalled,
    messagingAllowSiblings,
    messagingAgentInterrupt,
  } = opts
  // Effective `interrupt` when a call leaves it unset: config default, else
  // false. An explicit boolean on the call always wins (checked at each site).
  const interruptDefault = defaultAgentPromptInterrupt ?? false
  // agent_start's launch-card binding: the native MCP Apps tool once
  // `@agentik/session-chat` is installed, else the loopback-HTTP launcher
  // builtin-apps.ts still mounts as a fallback. See
  // `RegisterAgentToolsOptions.isSessionChatInstalled`.
  const sessionChatResourceUri = isSessionChatInstalled?.()
    ? `ui://${appUiToolId(SESSION_CHAT_APP_ID)}/view`
    : "ui://agentproto_session_chat/view"

  // ── agent_start ────────────────────────────────────────
  server.registerTool(
    "agent_start",
    {
      description:
        "Spawn a long-running agent CLI (claude-code, hermes, …) on the host. " +
      "The session stays alive across multiple turns — call `agent_prompt` " +
      "to continue the conversation. Returns the session id + initial descriptor. " +
      "When `workspaceSlug` is set, resolves the cwd via " +
      "`~/.agentproto/workspaces.json`; otherwise pass `cwd` explicitly or " +
      "fall back to the active workspace. " +
      "If you have shell access, `agentproto sessions start ...` is the CLI " +
      "equivalent. (No shell? Keep using this tool.)",
      inputSchema: agentStartInputShape,
      // Session-chat widget: rendering agent_start's result auto-mounts the
      // session-chat launcher for the new session (ext-apps
      // `_meta.ui.resourceUri` at the tool-definition level — same mechanism
      // as the panel apps in mcp-apps-adapter.ts). The widget reads the
      // spawned `{ id: "sess_…" }` off the host's tool-result notification
      // and deep-links the installed `@agentik/session-chat` app straight
      // into that session (apps/src/session-chat/panel.ts). The older
      // `ui://live_session/view` resource stays registered for its own
      // `live_session` tool and other consumers — only this binding moved.
      // `visibility:["model","app"]` keeps agent_start fully usable by the
      // model AND lets the widget re-call it if needed. `resourceUri` binds
      // to the native `app_ui_session_chat` MCP Apps tool once
      // `@agentik/session-chat` is installed (`isSessionChatInstalled`
      // above) — the loopback-HTTP `agentproto_session_chat` launcher this
      // otherwise binds to is unreachable under a strict-CSP host (Codex),
      // and builtin-apps.ts stops mounting it once the native tool exists.
      _meta: {
        ui: {
          resourceUri: sessionChatResourceUri,
          visibility: ["model", "app"],
        },
      },
    },
    async input => {
      if (!resolveAgentAdapter) {
        return {
          content: [
            {
              type: "text",
              text:
                "agent_start is not enabled — the daemon was started without " +
                "an adapter resolver. Re-run the daemon with the `@agentproto/cli` " +
                "shim wired (see playground/scripts/gateway.ts).",
            },
          ],
          isError: true,
        }
      }
      const preset = input.presetId ? await getUserPreset(input.presetId) : undefined
      if (input.presetId && !preset) {
        return {
          content: [{ type: "text", text: `agent_start: no user preset "${input.presetId}" found.` }],
          isError: true,
        }
      }
      const adapter = input.adapter ?? input.harness ?? preset?.adapter ?? preset?.harness
      if (!adapter) {
        return {
          content: [{ type: "text", text: "agent_start: adapter is required unless the selected preset provides one." }],
          isError: true,
        }
      }
      const { presetId: _presetId, posture: rawPosture, ...spawnInput } = input
      const result = await spawnAgentSession(
        {
          registry,
          resolveAgentAdapter,
          buildOrchestratorMcp,
          daemonMcpUrl,
          callerScope,
          webhookNotifier,
          loadRoleRegistry,
          resolveSandboxProvider,
          ...(provisionWorktree ? { provisionWorktree } : {}),
          ...(resolveWorktreeIsolation ? { resolveWorktreeIsolation } : {}),
          ...(listCatalogModels ? { listCatalogModels } : {}),
        },
        {
          ...spawnInput,
          adapter,
          // Auto-stamp the source channel (#session-visibility): when the
          // caller didn't pass an explicit `origin`, fall back to the connecting
          // client's `?origin=` label so a bridge-client spawn (cowork/vscode/
          // codex) is attributed instead of landing as a bare root. An explicit
          // `input.origin` (already in `spawnInput`) always wins.
          ...(!spawnInput.origin && mcpBridgeOrigin ? { origin: mcpBridgeOrigin } : {}),
          // The trusted caller id (from `?callerSessionId=`) becomes the
          // implicit auto-parent — attach-by-default without the caller
          // passing its own id. An explicit `parentSessionId` still outranks
          // it in `decideSpawnAttach`.
          ...(callerSessionId ? { autoParentSessionId: callerSessionId } : {}),
          ...(rawPosture ? { posture: parsePostureInput(rawPosture) } : {}),
          ...(preset ? { preset } : {}),
        },
      )
      if (result.ok) {
        // Phase 4: auto-attach a windowed cost-budget governance policy on the
        // freshly-spawned session. The gate carries the spawned session id
        // explicitly (so a profile-scoped budget resolves THAT session's
        // profileRef) and `then: "emit"` trips `policy:failed` on windowed
        // overage — it never kills the session (that's the orthogonal scalar
        // `maxCostUsd` cap). Best-effort: a supervisor-attach failure must not
        // sink an otherwise-successful spawn, so its policyId rides back as a
        // non-fatal warning rather than turning the spawn into an error.
        const attachWarnings: string[] = []
        let costBudgetPolicyId: string | undefined
        if (input.costBudget && supervisor && !result.deduped) {
          try {
            const state = supervisor.attach({
              sessionId: result.descriptor.id,
              gate: { costBudget: input.costBudget, sessionId: result.descriptor.id },
              then: "emit",
            })
            costBudgetPolicyId = state.policyId
          } catch (err) {
            attachWarnings.push(
              `cost-budget policy auto-attach failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        const warnings = [...(result.warnings ?? []), ...attachWarnings]
        const body = {
          ...result.descriptor,
          ...(result.output ? { output: result.output } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(result.deduped ? { deduped: true } : {}),
          ...(result.dedupeSource ? { dedupeSource: result.dedupeSource } : {}),
          ...(costBudgetPolicyId ? { costBudgetPolicyId } : {}),
        }
        return {
          content: [{ type: "text", text: JSON.stringify(body) }],
        }
      }
      // The orchestrator guardrail errors + the role-spawn gate have
      // always been reported as a structured JSON blob (error/message/
      // +details); every other failure is a plain-text message.
      // Preserved verbatim here so the MCP tool's output shape doesn't
      // change under this refactor.
      const text =
        result.code === "orchestrator_max_depth_exceeded" ||
        result.code === "orchestrator_child_quota_exceeded" ||
        result.code === "role_spawn_denied"
          ? JSON.stringify(
              { error: result.code, message: result.message, ...result.details },
              null,
              2,
            )
          : result.message
      return {
        content: [{ type: "text", text }],
        isError: true,
      }
    }
  )

  // ── agent_prompt ───────────────────────────────────────
  server.tool(
    "agent_prompt",
    "Send a follow-up prompt to a live agent session — multi-turn continuity " +
      "without re-spawning. The session id comes from `agent_start` " +
      "(or `agent_sessions_list`). Returns immediately; tail output via " +
      "`agent_output` or the SSE /sessions/:id/stream endpoint. If the " +
      "session is mid-turn, the prompt is queued (FIFO) and dispatched " +
      "automatically when the current turn ends on its own — so fan-in " +
      "bursts are delivered in order instead of rejected. A turn that is " +
      "interrupted instead leaves the queue parked until the next natural " +
      "turn-end. Pass `interrupt: true` to " +
      "cancel the in-flight turn and redirect the SAME session onto this " +
      "prompt instead, without losing its context (unlike `agent_kill`, " +
      "which ends the session entirely). `interrupt` is a no-op on an " +
      "already-idle session.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
      prompt: z.string().min(1).describe("The next user turn (plain text)."),
      interrupt: z
        .boolean()
        .optional()
        .describe(
          "When true and the session is mid-turn, cancel the in-flight " +
            "turn and deliver this prompt on the same session immediately " +
            "instead of queueing it behind the current turn. No-op when the " +
            "session is already idle. UNSET falls back to the daemon default " +
            "`defaults.agentPromptInterrupt` in config.json (false unless an " +
            "operator changed it) — so a mid-turn target queues by default; " +
            "pass `interrupt: true` explicitly to cut now."
        ),
      queue: z
        .boolean()
        .optional()
        .describe(
          "When the session is mid-turn, queue this prompt (FIFO) and " +
            "dispatch it automatically once the current turn ends instead " +
            "of rejecting. Default true. Explicit false restores the old " +
            "reject-when-busy behavior."
        ),
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_prompt")
      try {
        // enqueuePrompt awaits admission (resume attempt + the dead/
        // wrong-kind/busy checks) before resolving, then fires the
        // turn itself without waiting for it to drain — long turns
        // don't block this tool call. Only the awaited admission
        // phase can reject, so a dead session (killed by a daemon
        // restart, exited, errored) or a session already mid-turn
        // (and not `interrupt`ed) surfaces here as a real tool error
        // instead of a lying `{queued: true}` for a prompt that goes
        // nowhere. The caller polls agent_output for the turn's actual
        // progress/completion.
        // Prompt provenance: when this call is attributed to a session (the
        // scoped orchestrator gateway's verified scope, else the trusted
        // `?callerSessionId=` self-ref query), record the injected turn as
        // that agent's — a transcript view then shows the supervisor as the
        // author instead of "you". An unattributed call (a human operator
        // driving the MCP surface directly) stays source-less.
        const promptSource = callerScope?.ownerSessionId ?? callerSessionId
        // Explicit `interrupt` (true OR false) wins; UNSET falls back to the
        // configurable daemon default.
        const effectiveInterrupt = input.interrupt ?? interruptDefault
        const { queued } = await registry.enqueuePrompt(sessionId, input.prompt, {
          interrupt: effectiveInterrupt,
          // Queue by default: a mid-turn session holds the prompt in its
          // FIFO queue and dispatches it at turn end, so callers never
          // lose a prompt to the busy rejection. Explicit `queue: false`
          // restores the old reject-when-busy behavior.
          queue: input.queue ?? true,
          ...(promptSource ? { source: `agent:${promptSource}` } : {}),
        })
        // Self-documenting loop: the prompt actually parked behind an
        // in-flight turn (mid-turn + not interrupted) AND the caller never
        // said anything about `interrupt` — surface the option at the exact
        // moment it's missing, so it won't be delivered until the current
        // turn ends.
        const hintQueued = queued && input.interrupt === undefined
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  sessionId,
                  queued: true,
                  ...(hintQueued
                    ? {
                        delivery: "queued-mid-turn",
                        hint:
                          "Message queued — it will only be delivered when " +
                          "the target's CURRENT turn ends. If it's urgent, " +
                          "re-send with interrupt: true (cancels the in-flight " +
                          "turn and redirects the session onto this prompt now).",
                      }
                    : {}),
                },
                null,
                2
              ),
            },
          ],
        }
      } catch (err) {
        // With `queue: false` explicitly set, a mid-turn rejection must
        // name the caller's alternatives verbatim — the old bare
        // "wait for it to finish or cancel" gave no actionable path.
        let message = err instanceof Error ? err.message : String(err)
        if (input.queue === false && message.includes("is mid-turn")) {
          message = message.replace(
            "wait for it to finish or cancel",
            "pass queue: true, or use `agentproto sessions prompt`"
          )
        }
        return {
          content: [
            {
              type: "text",
              text: `agent_prompt: ${message}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── message_parent ─────────────────────────────────────
  // The child→parent half of the supervision channel. `agent_prompt` is a
  // delegation tool (drive ANY session by id, stripped from executor
  // children); this one is deliberately not: it takes no session id, the
  // daemon resolves the caller's own recorded `parentSessionId`, and it can
  // reach nothing else — which is why it stays out of
  // `DELEGATION_TOOL_NAMES` and is granted role-independently. Delivery
  // goes through `registry.sendMessage` like every typed message: routed by
  // urgency (fyi / next-turn / steer / interrupt), never concatenated with
  // another prompt, and a child can't cut its parent's turn unless the
  // operator granted it (`defaults.messaging.agentInterrupt: "allow"`).
  server.tool(
    "message_parent",
    "Report a message UP to the session that spawned you (your parent/" +
      "supervisor) — a result, a progress update, or a blocker. No session " +
      "id needed: the daemon resolves your recorded parent from your own " +
      "session identity (also visible as the AGENTPROTO_PARENT_SESSION_ID " +
      "env var). An idle parent gets it as its own turn right away. A busy " +
      "parent gets it by `urgency`: `next-turn` (default for report/done/" +
      "notice) waits for its current turn to end; `steer` (default for " +
      "blocker/question) is injected INTO its running turn when its agent " +
      "supports that, else next-turn; `fyi` only lands in its inbox. " +
      "`interrupt: true` asks to cancel the parent's turn — honoured only when " +
      "the operator allows it, otherwise delivered as `steer`. The result " +
      "reports the tier actually applied. Errors if this session has no " +
      "recorded parent or the parent is gone.",
    {
      message: z
        .string()
        .min(1)
        .describe("The message to deliver to your parent session (plain text)."),
      interrupt: z
        .boolean()
        .optional()
        .describe(
          "Ask to cancel the parent's in-flight turn and deliver this now " +
            "(urgency `interrupt`). Honoured only when config.json " +
            "`defaults.messaging.agentInterrupt` is \"allow\"; otherwise it's " +
            "delivered as `steer` (injected into the running turn when " +
            "possible) and the result says so. UNSET falls back to " +
            "`defaults.agentPromptInterrupt` (false by default).",
        ),
      urgency: z
        .enum(MESSAGE_URGENCIES as [MessageUrgency, ...MessageUrgency[]])
        .optional()
        .describe(
          "fyi | next-turn | steer | interrupt — see the tool description. " +
            "Default: steer for blocker/question, next-turn otherwise. " +
            "`interrupt: true` wins over this.",
        ),
      replyTo: z.string().optional().describe("Id of a parent message this answers (msg_…)."),
      kind: z
        .enum(MESSAGE_KINDS as [MessageKind, ...MessageKind[]])
        .optional()
        .describe(
          "What this message is: `report` (default — a result or progress), " +
            "`question` (you need an answer), `blocker` (you cannot proceed), " +
            "`done` (your task is complete), `notice` (informational). Shown " +
            "to the parent in the daemon-attested message header.",
        ),
    },
    async input => {
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true,
      })
      // The scoped gateway's token is the caller's identity; on the plain
      // `/mcp` path the trusted `?callerSessionId=` self-ref query is —
      // same precedence as spawn attribution (spawn-attach.ts).
      const selfId = callerScope?.ownerSessionId ?? callerSessionId
      if (!selfId) {
        return fail(
          "message_parent: cannot identify the calling session — this tool " +
            "needs gateway access attributed to a session (a scoped " +
            "orchestrator gateway, or a daemon `/mcp` URL carrying " +
            "`?callerSessionId=`). A human/root caller has no parent to message."
        )
      }
      const self = registry.get(selfId)
      if (!self) {
        return fail(`message_parent: calling session "${selfId}" is not in the registry.`)
      }
      const parentId = self.parentSessionId
      if (!parentId || parentId === selfId) {
        return fail(
          "message_parent: this session has no recorded parent — it was " +
            "spawned at the root, so there is no one to report up to."
        )
      }
      const parent = registry.get(parentId)
      if (!parent) {
        return fail(`message_parent: parent session "${parentId}" no longer exists.`)
      }
      if (parent.status !== "running" && parent.status !== "starting") {
        return fail(
          `message_parent: parent session "${parentId}" is not running ` +
            `(status: ${parent.status}) — the message cannot be delivered.`
        )
      }
      // The daemon-attested envelope: `from` comes from the verified caller
      // identity + the tree, never from the input. The parent sees it as an
      // `<agentproto-message from="child" session=…>` tag and its transcript
      // records a `session-message`, not a user prompt.
      // Explicit `interrupt` (true OR false) wins; UNSET falls back to the
      // configurable daemon default (symmetric with agent_prompt).
      const effectiveInterrupt = input.interrupt ?? interruptDefault
      const kind = input.kind ?? "report"
      const urgency: MessageUrgency = effectiveInterrupt
        ? "interrupt"
        : (input.urgency ?? defaultUrgencyForKind(kind))
      const envelope = createSessionMessage({
        to: parentId,
        from: messageFrom(self, "child"),
        text: input.message,
        kind,
        urgency,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      })
      const done = (
        delivery: "enqueued" | "queued-next-turn" | "interrupted" | "waited" | "steered",
        extra?: Record<string, unknown>,
      ) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              parentSessionId: parentId,
              messageId: envelope.id,
              delivery,
              ...extra,
            }),
          },
        ],
      })
      // `source` AND `origin` both carry `child:<sessionId>` — the turn's
      // provenance and the queue UI's label. Keyed on the session id, not the
      // child-settable label.
      const provenance = `child:${selfId}`
      // One delivery path for every typed message (`registry.sendMessage`):
      // a parent parked in `inbox_wait` gets the report as that call's
      // result (waiter-first); otherwise it's kept in the parent's inbox and
      // dispatched now (idle), steered into its running turn, or parked as
      // its OWN queued turn (busy) — never string-glued onto another prompt.
      let result: Awaited<ReturnType<SessionsRegistry["sendMessage"]>>
      try {
        result = await registry.sendMessage(envelope, {
          source: provenance,
          origin: provenance,
          allowInterrupt: messagingAgentInterrupt === "allow",
        })
      } catch (err) {
        return fail(
          `message_parent: could not deliver to parent session "${parentId}" — ` +
            (err instanceof Error ? err.message : String(err))
        )
      }
      const applied = {
        urgencyApplied: result.urgencyApplied,
        ...(result.urgencyApplied !== urgency && result.delivered?.via !== "wait"
          ? { note: `requested urgency "${urgency}" was delivered as "${result.urgencyApplied}"` }
          : {}),
      }
      if (result.delivered?.via === "wait") return done("waited", applied)
      if (result.delivered?.via === "steer") return done("steered", applied)
      if (result.delivered?.via === "interrupt") return done("interrupted", applied)
      if (!result.queued) return done("enqueued", applied)
      // Self-documenting loop: the parent is mid-turn, so this report waits
      // for its CURRENT turn to end — surface the faster tier when the
      // caller didn't ask for one.
      return done("queued-next-turn", {
        ...applied,
        ...(input.urgency === undefined && input.interrupt === undefined && urgency === "next-turn"
          ? {
              hint:
                "Message queued — it will only reach the parent when its " +
                "CURRENT turn ends. If it needs attention now, re-send with " +
                "urgency: \"steer\" (or kind: \"blocker\") to inject it into " +
                "the parent's running turn.",
            }
          : {}),
      })
    }
  )

  // ── message_send / message_reply / inbox_* ─────────
  registerMessageTools(server, {
    registry,
    ...(callerScope ? { callerScope } : {}),
    ...(callerSessionId ? { callerSessionId } : {}),
    ...(messagingAllowSiblings ? { allowSiblings: true } : {}),
    ...(messagingAgentInterrupt === "allow" ? { allowInterrupt: true } : {}),
  })

  // ── agent_output ───────────────────────────────────
  server.tool(
    "agent_output",
    "Tail the recent output of a session. Returns the last N lines of the " +
      "ring buffer (stdout + stderr inter-leaved, newest last). Use this to read " +
      "an agent's reply after `agent_prompt`.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
      lastN: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max lines to return. Default 80, max 500."),
      clean: mcpBool
        .optional()
        .describe(
          "Strip ANSI codes and drop framing/decoration lines, returning human-readable text."
        ),
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_output")
      const desc = registry.get(sessionId)
      if (!desc) {
        return {
          content: [
            { type: "text", text: `agent_output: no session "${sessionId}"` },
          ],
          isError: true,
        }
      }
      // Best-effort tail — re-attach with a temp listener, capture
      // backfill (which is the recent ring buffer), unsubscribe.
      const limit = input.lastN ?? 80
      const lines: string[] = []
      const unsub = registry.attach(sessionId, (line, _stream) => {
        lines.push(line)
      })
      if (unsub) unsub()
      const tail = lines.slice(-limit)
      let output = input.clean ? cleanAgentLines(tail) : tail
      // Resilience: a tool-busy turn emits `[tool]`/`[tool-result]` lines but
      // little or no assistant text, and clean mode strips those — so an agent
      // working hard (reading, writing files, installing) surfaces as an EMPTY
      // `lines`, which reads as "idle/stuck" to a polling orchestrator. When
      // clean output is empty but the ring HAS content, fall back to the
      // ANSI-stripped raw tail so the session's activity is always visible and
      // polling agent_output is a reliable liveness/progress signal.
      let activityFallback = false
      if (input.clean && output.length === 0 && tail.length > 0) {
        output = tail
          .map(stripAnsi)
          .map(l => l.trimEnd())
          .filter(l => l.trim().length > 0)
          .slice(-limit)
        activityFallback = output.length > 0
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sessionId,
                status: desc.status,
                currentPhase: desc.currentPhase,
                toolCallsThisTurn: desc.toolCallsThisTurn,
                lastOutputAt: desc.lastOutputAt,
                // Distinct liveness heartbeat: advances on ANY adapter-process
                // activity (streamed thinking/text deltas, tool traffic), even
                // across a stretch where the coalesced ring emits no new LINE
                // and `lastOutputAt` looks frozen. A monitor compares the two —
                // `lastActivityAt` moving while `lastOutputAt` is stale means
                // "alive and working", not "stalled". See SessionDescriptor.
                ...(desc.lastActivityAt ? { lastActivityAt: desc.lastActivityAt } : {}),
                ...(desc.secondsSinceLastActivity !== undefined
                  ? { secondsSinceLastActivity: desc.secondsSinceLastActivity }
                  : {}),
                // processAlive is a live OS query stamped by registry.get().
                ...(desc.processAlive !== undefined ? { processAlive: desc.processAlive } : {}),
                // Surfaced so a caller can distinguish "idle" from "mid tool
                // call" without guessing from empty output.
                ...(desc.blockedOn ? { blockedOn: desc.blockedOn } : {}),
                ...(activityFallback ? { activityFallback: true } : {}),
                // An ended session's derived outcome (what it produced) —
                // the ring above is empty for a row reloaded after a restart.
                ...(desc.outcome ? { outcome: desc.outcome } : {}),
                lines: output,
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )

  // ── agent_kill ─────────────────────────────────────────
  server.tool(
    "agent_kill",
    "Stop a session — SIGTERM the underlying child + close the agent protocol " +
      "session. Use to free resources after the operator is done, or when a " +
      "session is wedged.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_kill")
      // Subtree scoping (WP4): on the scoped sub-gateway a child
      // orchestrator may only kill sessions in its own subtree — never
      // an arbitrary id (e.g. a sibling's, or the root operator's). Full
      // list (includeArchived) so an archived ancestor doesn't sever the
      // parent→child graph collectSubtree's BFS walks.
      if (callerScope) {
        const subtree = collectSubtree(
          callerScope.ownerSessionId,
          registry.list({ includeArchived: true }),
        )
        if (!subtree.has(sessionId)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "orchestrator_session_out_of_scope",
                    message:
                      `agent_kill: session "${sessionId}" is not in ` +
                      `your subtree — a scoped orchestrator can only kill sessions ` +
                      `it (transitively) spawned. No action taken.`,
                    ok: false,
                    sessionId,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          }
        }
      }
      const ok = registry.kill(sessionId)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok, sessionId }),
          },
        ],
      }
    }
  )

  // ── agent_interrupt ─────────────────────────────────────
  server.tool(
    "agent_interrupt",
    "Cancel the in-flight turn on a live agent session and leave the session " +
      "alive and idle. Unlike `agent_kill` (ends the session entirely), the " +
      "session stays alive and ready for the next `agent_prompt`. Unlike " +
      "`agent_prompt({interrupt: true})` (which requires a next prompt to " +
      "redirect onto), this takes no prompt — it's just stop. Prompts " +
      "already queued behind the cancelled turn are NOT dispatched by the " +
      "stop: they stay queued and run after the next turn that ends on its " +
      "own. No-op (`wasBusy: false`) on an already-idle or terminal session.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_interrupt")
      try {
        const { wasBusy } = await registry.interruptSession(sessionId)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, sessionId, wasBusy }),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `agent_interrupt: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── agent_set_model ─────────────────────────────────────
  server.tool(
    "agent_set_model",
    "Switch the model on a LIVE agent-cli session without restarting it — " +
      "the mid-session counterpart to picking a model at `agent_start` time. " +
      "Dispatches on the adapter's own apply strategy: a session whose " +
      "adapter selects models via ACP session config or a `/model` control " +
      "turn switches live; one that takes its model as a spawn-time CLI " +
      "argument (e.g. codex) can't, and reports " +
      "`{applied:false, reason:\"requires-restart\"}` instead of failing. " +
      "Never throws on a rejected switch — check `applied` in the result.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
      model: z.string().describe("Model id to switch to."),
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_set_model")
      try {
        const result = await registry.setModel(sessionId, input.model)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, sessionId, ...result }),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `agent_set_model: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── agent_set_effort ─────────────────────────────────────
  server.tool(
    "agent_set_effort",
    "Switch the reasoning/compute budget (effort) on a LIVE agent-cli session " +
      "without restarting it — the effort-axis counterpart to `agent_set_model`. " +
      "Applied via the adapter's ACP session config. Effort is model-dependent: " +
      "the same label means a different budget across models and some labels are " +
      "model-gated (opus offers `ultracode`, haiku doesn't), so a label the " +
      "current model rejects reports `{applied:false, reason}` instead of " +
      "failing. Never throws on a rejected switch — check `applied` in the result.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
      effort: z
        .string()
        .describe(
          "Effort label to switch to (e.g. low/medium/high/xhigh/max/ultracode; " +
            "the accepted set is model-dependent).",
        ),
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_set_effort")
      try {
        const result = await registry.setEffort(sessionId, input.effort)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, sessionId, ...result }),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `agent_set_effort: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── agent_set_posture ─────────────────────────────────────
  server.tool(
    "agent_set_posture",
    "Switch the posture (what the agent may DO — plan / accept-edits / bypass / " +
      "read-only, or a raw harness mode id) on a LIVE agent-cli session. When the " +
      "posture maps to a NATIVE mode the harness advertises, it switches live " +
      "(`applied:true`). When there is no native mode (the posture would have to " +
      "be prompt-injected or applied at spawn), it is NOT forced live — the " +
      "result is `{applied:false, reason:\"requires-restart\"}` so the caller can " +
      "re-apply it through a session restart instead. Never throws on a rejected " +
      "switch — check `applied`.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
      posture: z
        .string()
        .describe(
          "Posture to switch to: a canonical value (default/plan/accept-edits/" +
            "bypass/read-only) or a raw harness mode id.",
        ),
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_set_posture")
      try {
        const result = await registry.setPosture(sessionId, parsePostureInput(input.posture))
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, sessionId, ...result }),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `agent_set_posture: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── agent_sessions_list ───────────────────────────────────────
  // Migrated onto the AIP contract layer (defineTool + implementTool +
  // toMcpTool) with the shared `paginated()` transformer — the same
  // pattern as session_list (#1201). COMPACT BY DEFAULT: each row is a
  // slim projection mirroring session_list's compact view; `full: true`
  // (or `compact: false`) returns the complete, unprojected descriptor.
  const compactAgentSessionItem = (s: SessionDescriptor) => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    label: s.label,
    status: s.status,
    pty: s.pty,
    command: s.command,
    cwd: s.cwd,
    adapterSlug: s.adapterSlug,
    model: s.model,
    busy: s.busy,
    awaitingInput: s.awaitingInput,
    blockedOn: s.blockedOn,
    ...(s.capabilities?.steering ? { steering: true } : {}),
    lastActivityAt: s.lastActivityAt,
    startedAt: s.startedAt,
    exitCode: s.exitCode,
    depth: s.depth,
    parentSessionId: s.parentSessionId,
    usageSource: s.usageSource,
    costUsd: s.costUsd,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    contextSize: s.contextSize,
    contextSizeSource: s.contextSizeSource,
    contextUsed: s.contextUsed,
  })
  const agentSessionsListSchema = z.object({
    kind: z
      .enum(["terminal", "agent-cli", "command", "all"])
      .optional()
      .describe(
        "Optional override of the default `agent-cli` filter. `all` returns every kind."
      ),
    onlyAlive: z
      .boolean()
      .optional()
      .describe("When true, only running/starting sessions. Default false."),
    status: z
      .enum(["starting", "running", "exited", "killed", "error"])
      .optional()
      .describe("Filter by exact status (overrides onlyAlive)."),
    ...pageParamsShape,
  })
  type AgentSessionsListInput = z.infer<typeof agentSessionsListSchema>

  registerBuiltinTool<AgentSessionsListInput, SessionDescriptor[]>(server, {
    id: "agent_sessions_list",
    description: "List agent-CLI sessions tracked by the daemon. Equivalent to `session_list({kind: 'agent-cli'})`. " +
      "Each entry includes `kind`, `status`, age, etc. Use this when you only want " +
      "the agent-CLI subset. COMPACT BY DEFAULT: each entry is a slim projection " +
      "(id/kind/name/label/status/command/cwd/model/busy/awaitingInput/blockedOn/" +
      "lastActivityAt/startedAt/exitCode/depth/parentSessionId); pass `full: true` " +
      "(or `compact: false`) for the complete, unprojected per-session record.",
    inputSchema: agentSessionsListSchema,
    handler: async (input) => {
      // Full list (includeArchived) for subtree correctness — see
      // session_list's docblock; archived rows are hidden below,
      // unconditionally (this tool has no includeArchived opt-in).
      let rows = registry.list({ includeArchived: true })
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, rows)
        rows = rows.filter(s => subtree.has(s.id))
      }
      rows = rows.filter(s => !s.archived)
      const kind = input.kind ?? "agent-cli"
      if (kind !== "all") {
        rows = rows.filter(s => s.kind === kind)
      }
      if (input.status) {
        rows = rows.filter(s => s.status === input.status)
      } else if (input.onlyAlive) {
        rows = rows.filter(
          s => s.status === "running" || s.status === "starting",
        )
      }
      return rows
    },
    transformers: [
      catchErrors(),
      paginated({
        project: compactAgentSessionItem,
        keyOf: s => s.id,
        maxLimit: 200,
        itemKey: "sessions",
      }),
    ],
  })

  // ── adapter_list ──────────────────────────────────────────────
  // Migrated onto the AIP contract layer (defineTool + implementTool +
  // toMcpTool) with the shared `paginated()` transformer. COMPACT BY
  // DEFAULT: the former `summary: true` projection (slug/name/version/
  // protocol/models — all a UI picker needs) is now the default view;
  // the full manifest echo (commands/modes/model details — can run to
  // hundreds of KB) is the `full: true` / `compact: false` opt-out.
  const compactAdapterItem = (a: AdapterListEntry) => ({
    slug: a.slug,
    name: a.name,
    version: a.version,
    protocol: a.protocol,
    models: a.models ?? [],
  })
  const adapterListSchema = z.object({
    ...pageParamsShape,
  })
  type AdapterListInput = z.infer<typeof adapterListSchema>

  registerBuiltinTool<AdapterListInput, AdapterListEntry[]>(server, {
    id: "adapter_list",
    description: "Enumerate every agent CLI adapter installed on the host (claude-code, " +
      "hermes, aider, …). Returns slug + display name + version + protocol so " +
      "callers can let users pick from the installed set instead of guessing. " +
      "Use before `agent_start` when the model doesn't already know " +
      "what's available. COMPACT BY DEFAULT: each entry carries only `slug`, " +
      "`name`, `version`, `protocol`, `models` — pass `full: true` (or " +
      "`compact: false`) for the full manifest projection (commands/modes/" +
      "model details, hundreds of KB).",
    inputSchema: adapterListSchema,
    handler: async () => {
      if (!listAgentAdapters) {
        throw new Error(
          "adapter_list is not enabled — the daemon was started without " +
            "an adapter lister. Wire `@agentproto/cli`'s " +
            "`listInstalledAdapters` via `createGateway({ listAgentAdapters })`.",
        )
      }
      return listAgentAdapters()
    },
    transformers: [
      catchErrors(),
      paginated({
        project: compactAdapterItem,
        keyOf: a => a.slug,
        maxLimit: 200,
        itemKey: "adapters",
      }),
    ],
  })

  // ── harness_capabilities ────────────────────────────────────────
  server.tool(
    "harness_capabilities",
    "Introspect what an installed agent CLI adapter can actually DO on this " +
      "host — where its credentials live, which billing providers it can " +
      "reach (and whether a credential is present for each, never the " +
      "credential value), how it discovers/reports its model list, whether " +
      "it can front an OpenAI/Anthropic-compatible endpoint, and how a " +
      "model/posture choice gets applied at spawn time. Complements " +
      "`adapter_list` (static manifest fields) with the live/parsed picture " +
      "from each adapter's own native config/creds store, falling back to a " +
      "manifest-only projection when no live discovery is available.",
    {
      adapter: z
        .string()
        .optional()
        .describe("Keep only this adapter slug. Omit for every installed adapter."),
    },
    async ({ adapter }) => {
      if (!listHarnessCapabilities) {
        return {
          content: [
            {
              type: "text",
              text:
                "harness_capabilities is not enabled — the daemon was started without " +
                "a capabilities lister. Wire `@agentproto/cli`'s harness-capabilities " +
                "lister via `createGateway({ listHarnessCapabilities })`.",
            },
          ],
          isError: true,
        }
      }
      try {
        const capabilities = await listHarnessCapabilities(adapter ? { adapter } : undefined)
        return {
          content: [{ type: "text", text: JSON.stringify({ capabilities }) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `harness_capabilities failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── adapter_install ───────────────────────────────────────────
  server.tool(
    "adapter_install",
    "Install an agent CLI adapter (harness) by slug that `adapter_list` " +
      "reports as not-yet-`ready` — both acp-catalog CLIs (`npm i -g " +
      "<package>`, e.g. gemini-cli) and first-party workspace adapters " +
      "(the manifest install pipeline). Returns the outcome + the adapter's " +
      "re-read status so a UI can refresh a row. Ordinary install failures " +
      "come back as `ok:false` (not an error), so call it and read the result.",
    {
      slug: z
        .string()
        .describe("Adapter slug to install (e.g. `gemini-cli`, `claude-code`)."),
    },
    async ({ slug }) => {
      if (!installAgentAdapter) {
        return {
          content: [
            {
              type: "text",
              text:
                "adapter_install is not enabled — the daemon was started without " +
                "an adapter installer. Wire `@agentproto/cli`'s " +
                "`installAdapter` via `createGateway({ installAgentAdapter })`.",
            },
          ],
          isError: true,
        }
      }
      try {
        const result = await installAgentAdapter(slug)
        // A failed install is a real DOMAIN result the caller must read
        // (`ok:false` + `message`), NOT an MCP error — deliberately no
        // `isError` here so the structured result survives the client's
        // result-unwrapping (an isError result is turned into a thrown
        // string, discarding the payload). isError is reserved for the
        // "not enabled" / thrown-exception faults, below.
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `adapter_install failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── catalog_models ────────────────────────────────────────────
  // Migrated onto the AIP contract layer (defineTool + implementTool +
  // toMcpTool) with the shared `paginated()` transformer. Rows are the
  // per-route FLATTENING the paginated branch always used (vendor +
  // product carried on each, every CatalogRoute field intact), COMPACT
  // BY DEFAULT: routing fields + small booleans only. `full: true` (or
  // `compact: false`) returns the complete per-route record (baseUrl/
  // pricing/contextWindow/maxOutput/eligibleProfiles/adapterModes/
  // adapters).
  const compactCatalogRouteItem = (
    e: { vendor: string; product: string } & CatalogRoute,
  ) => ({
    vendor: e.vendor,
    product: e.product,
    route: e.route,
    ref: e.ref,
    runnable: e.runnable,
    curated: e.curated,
    multiModel: e.multiModel,
  })
  const catalogModelsSchema = z.object({
    adapter: z.string().optional().describe("Keep only routes reachable via this adapter slug."),
    vendor: z.string().optional().describe("Keep only this vendor's entry."),
    route: z.string().optional().describe("Keep only routes with this route id."),
    runnableOnly: mcpBool.optional().describe("Drop every route with runnable:false."),
    ...pageParamsShape,
  })
  type CatalogModelsInput = z.infer<typeof catalogModelsSchema>

  registerBuiltinTool<CatalogModelsInput, Array<{ vendor: string; product: string } & CatalogRoute>>(server, {
    id: "catalog_models",
    description: "Read-only vendor/product/route catalog (SPEC §5) — every model this " +
      "host can reach, widened beyond any one adapter's model list via " +
      "OpenRouter/Requesty/HuggingFace routing, with a profile-aware " +
      "`runnable` flag per route. Use before `agent_start` to see what's " +
      "actually spawnable given the auth profiles configured on this host. " +
      "Returns one FLATTENED row per route (vendor/product carried on each), " +
      "COMPACT BY DEFAULT: vendor/product/route/ref/runnable/curated/" +
      "multiModel only — pass `full: true` (or `compact: false`) for the " +
      "complete per-route record (pricing, contextWindow, maxOutput, " +
      "eligibleProfiles, adapterModes, adapters, baseUrl).",
    inputSchema: catalogModelsSchema,
    handler: async (input) => {
      if (!listCatalogModels) {
        throw new Error(
          "catalog_models is not enabled — the daemon was started without " +
            "a catalog lister. Wire `buildCatalogModels` via " +
            "`createGateway({ listCatalogModels })`.",
        )
      }
      const catalog = await listCatalogModels({
        ...(input.adapter ? { adapter: input.adapter } : {}),
        ...(input.vendor ? { vendor: input.vendor } : {}),
        ...(input.route ? { route: input.route } : {}),
        ...(input.runnableOnly ? { runnableOnly: true } : {}),
      })
      // Flatten the nested vendor/product tree to per-route entries — the
      // cursor's decoded `i` is the offset over this filtered array (no
      // stable keyset in the catalog; same semantics as PR-3).
      return catalog.vendors.flatMap(v =>
        v.products.flatMap(p =>
          p.routes.map(r => ({ vendor: v.vendor, product: p.product, ...r })),
        ),
      )
    },
    transformers: [
      catchErrors(),
      paginated({
        project: compactCatalogRouteItem,
        maxLimit: 200,
        itemKey: "routes",
      }),
    ],
  })

  // ── catalog_provider_models ───────────────────────────────────
  // Migrated onto the AIP contract layer (defineTool + implementTool +
  // toMcpTool) with the shared `paginated()` transformer. COMPACT BY
  // DEFAULT: id/kind/label/route per row (all a picker renders);
  // pricing/addedAt stay behind `full: true`.
  const compactProviderModelItem = (m: CatalogProviderModel) => ({
    id: m.id,
    kind: m.kind,
    label: m.label,
    route: m.route,
  })
  const catalogProviderModelsSchema = z.object({
    endpoint: z
      .string()
      .optional()
      .describe("Provider / billing endpoint to enumerate (anthropic, openai, openrouter, replicate, …)."),
    route: z
      .string()
      .optional()
      .describe("Synonym for endpoint (takes precedence when both are given)."),
    ...pageParamsShape,
  })
  type CatalogProviderModelsInput = z.infer<typeof catalogProviderModelsSchema>

  registerBuiltinTool<CatalogProviderModelsInput, CatalogProviderModel[]>(server, {
    id: "catalog_provider_models",
    description: "Read-only EXHAUSTIVE model list for ONE provider (AIP-45 launch-menu " +
      '"+" picker) — every model `endpoint`/`route` can serve, straight from ' +
      "the static catalog. Deliberately separate from `catalog_models`: that " +
      "tool is the lean spawn catalog (curated pairs widened through routers, " +
      "profile-aware `runnable`); THIS is the full provider surface the picker " +
      "browses before any adapter/profile is chosen, so it takes no host " +
      "state. An unknown/empty provider returns an empty list, never an error. " +
      "Large providers (openrouter is thousands) — paginate with `limit`/" +
      "`cursor`. COMPACT BY DEFAULT: id/kind/label/route per row; `full: true` " +
      "(or `compact: false`) adds pricing/addedAt.",
    inputSchema: catalogProviderModelsSchema,
    handler: async (input) => {
      // Never throws: an unknown provider is a valid empty answer
      // (buildCatalogProviderModels guarantees `{ models: [] }`); any
      // residual throw is defence-in-depth handled by `catchErrors()`.
      const result = buildCatalogProviderModels({
        ...(input.endpoint ? { endpoint: input.endpoint } : {}),
        ...(input.route ? { route: input.route } : {}),
      })
      return result.models
    },
    transformers: [
      catchErrors(),
      paginated({
        project: compactProviderModelItem,
        keyOf: m => m.id,
        maxLimit: 200,
        itemKey: "models",
      }),
    ],
  })

  // ── role_list ─────────────────────────────────────────────────
  // Migrated onto the AIP contract layer (defineTool + implementTool +
  // toMcpTool) with the shared `paginated()` transformer. The handler
  // already projects each role to the compact row this tool exists to
  // surface (name/level/delegation/spawnable — spawnable is the point
  // of the tool), so the compact projection is that row verbatim and
  // `full: true` is a no-op.
  interface RoleListRow {
    name: string
    level: number
    delegation: string
    spawnable: string[]
  }
  const compactRoleItem = (r: RoleListRow): RoleListRow => r
  const roleListSchema = z.object({
    ...pageParamsShape,
  })
  type RoleListInput = z.infer<typeof roleListSchema>

  registerBuiltinTool<RoleListInput, RoleListRow[]>(server, {
    id: "role_list",
    description: "Enumerate every spawn-time role known to the daemon — the two " +
      "built-ins (executor, supervisor) plus any custom role installed as " +
      "a role pack. Read-only: pure visibility into the same registry " +
      "`agent_start`'s `role` field and privilege-lattice spawn gate use — " +
      "this tool never itself grants or denies a spawn. Use before " +
      "`agent_start` with `orchestrator` to discover which roles this " +
      "session may in turn spawn. Each row is already the compact view " +
      "(name/level/delegation/spawnable).",
    inputSchema: roleListSchema,
    handler: async () => {
      const registry = loadRoleRegistry ? await loadRoleRegistry() : await loadDefaultRoleRegistry()
      return listRoles(registry).map<RoleListRow>(role => ({
        name: role.name,
        level: role.level,
        delegation: role.toolPolicy.delegation,
        spawnable: spawnableRolesFor(role, registry).map(child => child.name),
      }))
    },
    transformers: [
      catchErrors(),
      paginated({
        project: compactRoleItem,
        keyOf: r => r.name,
        maxLimit: 200,
        itemKey: "roles",
      }),
    ],
  })
}

export interface ExportSessionOps {
  registry: SessionsRegistry
  /**
   * Override the export function — primarily for testing so callers can inject
   * a stub without needing real JSONL / SQLite fixtures.
   */
  exportFn?: (input: ExportAgentSessionInput) => Promise<ExportAgentSessionResult>
}

/**
 * Register the `agent_export` MCP tool.
 *
 * Wraps `exportAgentSession` from transcript-export.ts. Resolves the session
 * descriptor via the registry (same registry-access pattern as `summarize_session`)
 * then delegates to the per-adapter exporter (claude-code JSONL / hermes SQLite).
 * Returns the rendered transcript as a text content block.
 */
export function registerExportSessionTool(server: McpServer, ops: ExportSessionOps): void {
  const doExport = ops.exportFn ?? exportAgentSession
  server.tool(
    "agent_export",
    "Export a clean, human-readable transcript of an agent session. " +
      "Prefers the source the adapter already persists (claude-code: JSONL in " +
      "~/.claude/projects/; hermes: state.db in ~/.hermes/), falling back to " +
      "agentproto's own daemon-captured events.jsonl for every other adapter " +
      "(or once the native store is unreadable). Returns markdown (default) or " +
      "JSON. Works on stopped and running sessions alike. Use after a long " +
      "agent run to review the full conversation without the ANSI noise of the " +
      "ring buffer.",
    {
      sessionId: z
        .string()
        .optional()
        .describe(
          "agentproto session id (sess_xxx), adapter-native id, or session name. " +
            "Accepts either `sessionId` or its alias `id`.",
        ),
      id: sessionIdAliasField,
      adapter: z.string().optional().describe(
        "Override adapter slug (e.g. 'claude-code', 'hermes') when the session " +
          "is not in the registry. Required when passing a raw adapter-native id."
      ),
      cwd: z.string().optional().describe(
        "Override cwd (absolute path) — required for claude-code when the session " +
          "is not in the registry (used to locate the JSONL file)."
      ),
      format: z.enum(["markdown", "json"]).optional().describe(
        "Output format. `markdown` (default) renders a human-friendly transcript " +
          "with a metadata table and role-labelled messages; `json` returns the raw " +
          "ExportedSession object for programmatic processing."
      ),
      source: z.enum(["auto", "native", "daemon"]).optional().describe(
        "Which backend to read from. `auto` (default) prefers the adapter's own " +
          "native store (claude-code JSONL / hermes SQLite) and falls back to " +
          "agentproto's own events.jsonl capture when there isn't one; `native` / " +
          "`daemon` force one and surface its own error instead of falling back."
      ),
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_export")
      const result = await doExport({
        sessionId,
        registry: ops.registry,
        ...(input.adapter ? { adapter: input.adapter } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.source ? { source: input.source } : {}),
      })
      const isError = result.content.startsWith("Error:")
      return {
        content: [{ type: "text" as const, text: result.content }],
        ...(isError ? { isError: true as const } : {}),
      }
    },
  )
}

/**
 * Compute the set of session ids in the subtree rooted at `rootId` —
 * the root itself plus every descendant reachable through the
 * `parentSessionId` chain (orchestrator WP4). Used to scope
 * `list`/`kill` on the scoped sub-gateway so a child orchestrator only
 * ever sees/affects the sessions it (transitively) spawned, never the
 * whole daemon. Returns an empty set when `rootId` is undefined (an
 * unbound scope sees nothing — safe default).
 *
 * Shared between agent-tools.ts and session-tools.ts; declared here so
 * both modules can use it without an extra util file for this PR.
 */
export function collectSubtree(
  rootId: string | undefined,
  all: readonly import("./sessions.js").SessionDescriptor[],
): Set<string> {
  const result = new Set<string>()
  if (!rootId) return result
  const childrenOf = new Map<string, string[]>()
  for (const s of all) {
    if (!s.parentSessionId) continue
    const arr = childrenOf.get(s.parentSessionId)
    if (arr) arr.push(s.id)
    else childrenOf.set(s.parentSessionId, [s.id])
  }
  const queue = [rootId]
  result.add(rootId)
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const child of childrenOf.get(id) ?? []) {
      if (!result.has(child)) {
        result.add(child)
        queue.push(child)
      }
    }
  }
  return result
}

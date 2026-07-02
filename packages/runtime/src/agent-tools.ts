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
 *   agent_export  export a clean transcript
 *   agent_sessions_list   browse alive + recent agent sessions
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { AcpMcpServer } from "@agentproto/acp"
import type { SessionsRegistry } from "./sessions.js"
import {
  exportAgentSession,
  type ExportAgentSessionInput,
  type ExportAgentSessionResult,
} from "./transcript-export.js"
import type {
  AgentAdapterResolver,
  AgentAdapterLister,
} from "./http-server.js"
import { jsonTolerant } from "./json-tolerant.js"
import type { OrchestratorScope } from "./orchestrator-gateway.js"
import type { WebhookNotifier } from "./webhook-notifier.js"
import { spawnAgentSession, cleanAgentLines } from "./session-spawn.js"

/** Strip CSI/SGR ANSI escape sequences. Exported for test access. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
}

/** MCP clients commonly stringify scalar arguments ("true"/"false"/"42").
 *  These coercers let a flag work whether the client sends a real JSON
 *  boolean/number or its string form — avoids opaque "expected boolean,
 *  received string" validation errors over the wire. */
const mcpBool = z.preprocess(
  v => (v === "true" ? true : v === "false" ? false : v),
  z.boolean(),
)
const mcpPositiveNumber = z.preprocess(
  v => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z.number().positive(),
)

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
  /** The daemon's own plain `/mcp` gateway URL (e.g.
   *  `http://127.0.0.1:18790/mcp`). When set, `agent_start` for a
   *  `hermes` adapter with no caller-supplied `mcpServers` defaults to
   *  mounting this gateway — unlike claude-code, hermes has zero
   *  built-in tools, so omitting `mcpServers` silently produces a
   *  chat-only session with no error. An explicit `mcpServers: []` is
   *  still respected as a deliberate opt-out. Omitted → no default
   *  (today's behaviour). */
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
  /** Optional webhook notifier — when provided, per-session `notifyUrl`
   *  values from `agent_start` are registered on spawn and
   *  unregistered on exit via the session-event bus. */
  webhookNotifier?: WebhookNotifier
}

export function registerAgentTools(
  server: McpServer,
  opts: RegisterAgentToolsOptions
): void {
  const {
    registry,
    resolveAgentAdapter,
    listAgentAdapters,
    buildOrchestratorMcp,
    callerScope,
    webhookNotifier,
    daemonMcpUrl,
  } = opts

  // ── agent_start ────────────────────────────────────────
  server.tool(
    "agent_start",
    "Spawn a long-running agent CLI (claude-code, hermes, …) on the host. " +
      "The session stays alive across multiple turns — call `agent_prompt` " +
      "to continue the conversation. Returns the session id + initial descriptor. " +
      "When `workspaceSlug` is set, resolves the cwd via " +
      "`~/.agentproto/workspaces.json`; otherwise pass `cwd` explicitly or " +
      "fall back to the active workspace.",
    {
      adapter: z
        .string()
        .min(1)
        .describe(
          "Adapter slug — one of the installed `@agentproto/adapter-*` packages " +
            "(e.g. 'claude-code', 'hermes', 'aider')."
        ),
      workspaceSlug: z
        .string()
        .optional()
        .describe(
          "Workspace slug from `agentproto workspace list`. The daemon resolves it " +
            "to an absolute path. Omit to use the `cwd` field or the active workspace."
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          "Absolute path to spawn the agent in. Wins over `workspaceSlug` when both are set."
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          "Optional initial prompt. The session is spawned and the prompt dispatched " +
            "in one shot — equivalent to `start` then `prompt` back-to-back. Skip to spawn idle."
        ),
      label: z
        .string()
        .optional()
        .describe(
          "Free-text label that surfaces in `agent_sessions_list` and the UI — useful " +
            "for tagging sessions with a conversation id or operator name."
        ),
      mode: z
        .string()
        .optional()
        .describe(
          "Manifest-declared mode id (AIP-45 `modes`) applied at spawn time, BEFORE " +
            "the child process starts — e.g. claude-code's 'plan' (read-only: " +
            "reasons and proposes but does not edit or run commands), 'accept-edits', " +
            "'bypass-permissions'; codex's 'read-only' / 'full-access'; mastracode/" +
            "opencode's 'plan' / 'build'. Adapters that don't declare `modes` (e.g. " +
            "hermes) reject ANY value here — only pass this for adapters known to " +
            "support it. Omit for the adapter's normal interactive mode."
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Model identifier to pass to the adapter (e.g. 'claude-opus-4-8'). " +
            "For ACP adapters (claude-code) applied via session/set_config_option " +
            "after newSession — NOT via a CLI flag. Others may ignore it."
        ),
      effort: z
        .string()
        .optional()
        .describe(
          "Reasoning effort level (e.g. 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'). " +
            "IMPORTANT: effort is calibrated per model — the same label maps to different " +
            "compute budgets across models, and defaults differ by model " +
            "(Sonnet 4.6 / Opus 4.8 default 'high'; Opus 4.7 default 'xhigh'). " +
            "'max' and 'ultracode' are session-only. Omit to keep the model's own default."
        ),
      mcpServers: jsonTolerant(
        z.array(
          z.object({
            name: z.string(),
            transport: z.enum(["stdio", "http", "sse"]),
            ref: z.string().optional(),
          })
        )
      )
        .optional()
        .describe(
          "MCP servers to mount into the spawned agent's session at spawn time. " +
            "Forwarded verbatim to `session/new.mcpServers` on the ACP arm — gives " +
            "the child agent a host-chosen scoped toolset (e.g. the daemon's own " +
            "orchestration gateway so it can spawn + supervise sub-agents). " +
            "Adapters that don't model MCP mounting ignore it."
        ),
      orchestrator: jsonTolerant(
        z.union([
          z.boolean(),
          z.object({
            tools: z
              .array(z.string())
              .optional()
              .describe(
                "Explicit allowlist — narrows the orchestration toolset to ⊆ the " +
                  "default subset. Names outside the default are dropped (a child " +
                  "can never widen its own scope). Omit for the full default subset."
              ),
            maxDepth: z
              .number()
              .int()
              .min(1)
              .max(8)
              .optional()
              .describe(
                "Max recursion depth reachable through this child (default 3, hard " +
                  "ceiling 8). A spawn that would exceed it is rejected. For a " +
                  "recursive spawn it can only LOWER the inherited cap, never raise it."
              ),
            maxChildren: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe(
                "Max concurrently-alive sub-agents this child may spawn (default 8). " +
                  "For a recursive spawn it can only lower the inherited quota."
              ),
          }),
        ])
      )
        .optional()
        .describe(
          "Make this child a SCOPED orchestrator — auto-mount the daemon's own " +
            "orchestration MCP tools (start/prompt/wait/poll/output + subtree " +
            "list/kill) so it can spawn and supervise its OWN sub-agents. " +
            "`true` = the default curated subset; `{ tools: [...] }` narrows it. " +
            "The daemon mints a per-child scope-token, injects the scoped " +
            "sub-gateway URL into the child's session (alongside any `mcpServers` " +
            "you pass), and revokes the token when the session exits. Shell/fs/" +
            "remote/import/terminal tools are NEVER exposed this way."
        ),
      notifyUrl: z
        .string()
        .url()
        .optional()
        .describe(
          "Optional per-session webhook URL. POSTed (fire-and-forget) on this " +
            "session's turn-end / awaiting-input / exited events, in addition to " +
            "any global notify URL."
        ),
      wait: mcpBool
        .optional()
        .describe(
          "Block until the spawned session's first turn completes and include the cleaned output in the response. Default false = return the descriptor immediately."
        ),
      maxCostUsd: mcpPositiveNumber
        .optional()
        .describe(
          "Hard ceiling on cumulative session cost (USD). The session is stopped at a turn-end once exceeded."
        ),
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
      const result = await spawnAgentSession(
        {
          registry,
          resolveAgentAdapter,
          buildOrchestratorMcp,
          daemonMcpUrl,
          callerScope,
          webhookNotifier,
        },
        input,
      )
      if (result.ok) {
        const body = result.output
          ? { ...result.descriptor, output: result.output }
          : result.descriptor
        return {
          content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
        }
      }
      // The two orchestrator guardrail errors have always been reported
      // as a structured JSON blob (error/message/+details); every other
      // failure is a plain-text message. Preserved verbatim here so the
      // MCP tool's output shape doesn't change under this refactor.
      const text =
        result.code === "orchestrator_max_depth_exceeded" ||
        result.code === "orchestrator_child_quota_exceeded"
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
      "`agent_output` or the SSE /sessions/:id/stream endpoint.",
    {
      sessionId: z.string().describe("Session id returned by agent_start."),
      prompt: z.string().min(1).describe("The next user turn (plain text)."),
    },
    async input => {
      try {
        // Note: sendPrompt awaits the full turn (drains the event
        // stream into the ring buffer). For long turns the operator
        // would prefer fire-and-forget — kick the promise without
        // awaiting and report "queued". The caller polls
        // agent_output for completion.
        void registry.sendPrompt(input.sessionId, input.prompt).catch(() => {
          // Errors land in the ring buffer; nothing to do here.
        })
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, sessionId: input.sessionId, queued: true },
                null,
                2
              ),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `agent_prompt: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── agent_output ───────────────────────────────────
  server.tool(
    "agent_output",
    "Tail the recent output of a session. Returns the last N lines of the " +
      "ring buffer (stdout + stderr inter-leaved, newest last). Use this to read " +
      "an agent's reply after `agent_prompt`.",
    {
      sessionId: z.string().describe("Session id."),
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
      const desc = registry.get(input.sessionId)
      if (!desc) {
        return {
          content: [
            { type: "text", text: `agent_output: no session "${input.sessionId}"` },
          ],
          isError: true,
        }
      }
      // Best-effort tail — re-attach with a temp listener, capture
      // backfill (which is the recent ring buffer), unsubscribe.
      const limit = input.lastN ?? 80
      const lines: string[] = []
      const unsub = registry.attach(input.sessionId, (line, _stream) => {
        lines.push(line)
      })
      if (unsub) unsub()
      const tail = lines.slice(-limit)
      const output = input.clean ? cleanAgentLines(tail) : tail
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sessionId: input.sessionId,
                status: desc.status,
                lastOutputAt: desc.lastOutputAt,
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
      sessionId: z.string().describe("Session id."),
    },
    async input => {
      // Subtree scoping (WP4): on the scoped sub-gateway a child
      // orchestrator may only kill sessions in its own subtree — never
      // an arbitrary id (e.g. a sibling's, or the root operator's).
      if (callerScope) {
        const subtree = collectSubtree(
          callerScope.ownerSessionId,
          registry.list(),
        )
        if (!subtree.has(input.sessionId)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "orchestrator_session_out_of_scope",
                    message:
                      `agent_kill: session "${input.sessionId}" is not in ` +
                      `your subtree — a scoped orchestrator can only kill sessions ` +
                      `it (transitively) spawned. No action taken.`,
                    ok: false,
                    sessionId: input.sessionId,
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
      const ok = registry.kill(input.sessionId)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok, sessionId: input.sessionId }, null, 2),
          },
        ],
      }
    }
  )

  // ── agent_sessions_list ───────────────────────────────────────
  server.tool(
    "agent_sessions_list",
    "List agent-CLI sessions tracked by the daemon. Equivalent to `session_list({kind: 'agent-cli'})`. " +
      "Each entry includes `kind`, `status`, age, etc. Use this when you only want " +
      "the agent-CLI subset.",
    {
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
    },
    async input => {
      let rows = registry.list()
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, rows)
        rows = rows.filter(s => subtree.has(s.id))
      }
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
      return {
        content: [
          { type: "text", text: JSON.stringify({ sessions: rows }, null, 2) },
        ],
      }
    },
  )

  // ── adapter_list ──────────────────────────────────────────────
  server.tool(
    "adapter_list",
    "Enumerate every agent CLI adapter installed on the host (claude-code, " +
      "hermes, aider, …). Returns slug + display name + version + protocol so " +
      "callers can let users pick from the installed set instead of guessing. " +
      "Use before `agent_start` when the model doesn't already know " +
      "what's available.",
    {},
    async () => {
      if (!listAgentAdapters) {
        return {
          content: [
            {
              type: "text",
              text:
                "adapter_list is not enabled — the daemon was started without " +
                "an adapter lister. Wire `@agentproto/cli`'s " +
                "`listInstalledAdapters` via `createGateway({ listAgentAdapters })`.",
            },
          ],
          isError: true,
        }
      }
      try {
        const adapters = await listAgentAdapters()
        return {
          content: [{ type: "text", text: JSON.stringify({ adapters }, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `adapter_list failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )
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
      sessionId: z.string().describe(
        "agentproto session id (sess_xxx), adapter-native id, or session name."
      ),
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
      const result = await doExport({
        sessionId: input.sessionId,
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

/**
 * MCP tools over the Task ledger (`task-ledger.ts`):
 *   task_create / task_list / task_claim / task_update
 *
 * Registered from `registerOrchestrationTools` and listed in
 * `DEFAULT_ORCHESTRATOR_TOOLS` — tasks are exactly what spawned children
 * SHOULD touch. Like the policy tools, the four names are registered
 * UNCONDITIONALLY (a tool declared in a scope's subset but not registered
 * on the server hangs the MCP handshake — empirically verified); when no
 * ledger is wired the handlers answer a structured error instead.
 *
 * All four go through the same (possibly wrapped) server, so every default
 * mount lists all four or none — `DEFAULT_ALWAYS_ON_TOOLS` (index.ts) keeps
 * them together under deferred loading. A session that sees `task_list` but
 * not the write verbs is on a mount configured to split them: a custom
 * `defaults.mcp.deferredTools.alwaysOn` (it REPLACES the default set) that
 * names only `task_list` ⇒ the other three are deferred, reachable through
 * `tool_search`; or an `allowTools` scope (AGENT.md `tools:`) that names only
 * `task_list` ⇒ they are not registered at all. `session_capabilities`
 * shows which list the harness actually loaded. Pinned by
 * `__tests__/task-tools-visibility.test.ts`.
 *
 * Caller identity drives ACL + the default board: a scoped child arrives
 * with `callerScope.ownerSessionId` (the same identity the policy tools
 * scope on) → a `{kind:"session"}` caller whose default board is its
 * lineage's `tree:<root>`; the root `/mcp` endpoint attributed by
 * `?callerSessionId=` is ALSO that session (not the operator), so its
 * default board is its `tree:<root>` too. Only a root endpoint with no
 * caller attribution falls back to the operator, whose default board is
 * `ws:<workspaceSlug>`. An unbound scope (token minted, owner not yet
 * bound) can act as nobody — same refusal as `policy_attach`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z, type ZodRawShape } from "zod"

import { gateInputSchema } from "./orchestration-tools.js"
import { jsonTolerant } from "./json-tolerant.js"
import { opaqueSchema } from "./tool-schema-opaque.js"
import { withToolSubset } from "./tool-subset.js"
import { paginate, pageParamsShape, toolText, type PageParams } from "./tool-envelope.js"
import { catchErrors, type ToolTransformer } from "@agentproto/tool"
import { registerBuiltinTool } from "@agentproto/mcp-server"
import { TASK_STATUSES } from "./task-ledger.js"
import type {
  TaskCaller,
  TaskLedger,
  TaskRecord,
  TaskWriteResult,
} from "./task-ledger.js"

type McpTextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean }

/**
 * Local companion to the shared `paginated()` transformer for tools whose
 * LEGACY (non-paginated) output is not `paginated`'s `{[itemKey]: rows}`
 * wrapper — here `{boardId, tasks}`. Same cursor/limit/compact/fields
 * pipeline via the shared primitives, but the default branch emits
 * `defaultBody(projectedRows)`, and any non-array handler output (this
 * file's guard replies: no-ledger, unbound-scope) passes through
 * untouched.
 */
function paginatedLegacyList<TItem extends object>(opts: {
  project: (item: TItem) => object
  keyOf: (item: TItem) => string | number | null
  defaultBody: (rows: object[], input: unknown) => unknown
}): ToolTransformer<unknown, unknown, McpTextResult> {
  return {
    name: "paginatedLegacyList",
    wrapShape: (shape): ZodRawShape => ({ ...shape, ...pageParamsShape }),
    wrapHandler: inner => async input => {
      const params = (input ?? {}) as PageParams
      const out = (await inner(input)) as unknown
      if (!Array.isArray(out)) return out as McpTextResult
      const items = out as readonly TItem[]
      const full = params.full === true
      const compact = full ? false : params.compact !== false
      if (params.limit !== undefined || params.cursor !== undefined) {
        const page = paginate(items, params, { maxLimit: 200, keyOf: opts.keyOf })
        const rows = compact ? page.items.map(opts.project) : page.items
        return { content: [{ type: "text", text: toolText({ ...page, items: [...rows] }, params) }] }
      }
      const rows = compact ? items.map(opts.project) : [...items]
      return { content: [{ type: "text", text: JSON.stringify(opts.defaultBody(rows as object[], input)) }] }
    },
  }
}

export interface RegisterTaskToolsOptions {
  /** The ledger. Absent → the tools register but answer a structured
   *  "task ledger not available" error (handshake-safe). */
  ledger?: TaskLedger
  /** The calling orchestrator's scope, when the tools are being mounted on
   *  the scoped sub-gateway. Same shape the policy tools take. */
  callerScope?: { ownerSessionId?: string }
  /** The calling session id read from `?callerSessionId=` on the ROOT `/mcp`
   *  endpoint — the same per-request identity `registerOrchestrationTools`
   *  receives. It only NARROWS privileges (operator → session), never widens
   *  them, and a bound `callerScope` outranks it. */
  callerSessionId?: string
  /** Optional allowlist — same semantics as the other register passes. */
  toolSubset?: ReadonlySet<string>
}

/** JSON-in-a-text-block reply, the house shape for these tool families. */
function jsonContent(payload: unknown): {
  content: Array<{ type: "text"; text: string }>
} {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] }
}

/** Render a ledger write result onto the tool reply. A rev-CAS conflict is
 *  a FIRST-CLASS reply (`{conflict:true, current}`) — the caller rebases
 *  off `current`, it isn't a tool error. */
function writeResultContent(result: TaskWriteResult): {
  content: Array<{ type: "text"; text: string }>
} {
  if (result.ok) {
    return jsonContent({
      task: result.task,
      ...(result.verifying ? { verifying: true } : {}),
    })
  }
  if (result.conflict) {
    return jsonContent({ conflict: true, current: result.current })
  }
  return jsonContent({ error: result.error })
}

export function registerTaskTools(
  rawServer: McpServer,
  opts: RegisterTaskToolsOptions,
): void {
  const server = opts.toolSubset
    ? withToolSubset(rawServer, opts.toolSubset)
    : rawServer
  const { ledger, callerScope, callerSessionId } = opts

  /**
   * Resolve the calling identity. A bound scope is that session; an unbound
   * scope is nobody — the caller gets a clear refusal rather than silently
   * acting as the operator. Without a scope, a root `/mcp` caller attributed
   * by `?callerSessionId=` is that session; only an unattributed root call
   * is the operator.
   */
  const resolveCaller = (): TaskCaller | { error: string } => {
    if (callerScope) {
      if (!callerScope.ownerSessionId) {
        return { error: "scope is not yet bound to a session; cannot touch tasks" }
      }
      return { kind: "session", sessionId: callerScope.ownerSessionId }
    }
    if (callerSessionId) return { kind: "session", sessionId: callerSessionId }
    return { kind: "operator" }
  }

  const notAvailable = jsonContent({ error: "task ledger not available" })

  // ── task_create ───────────────────────────────────────────────────
  server.tool(
    "task_create",
    "Create a task on the caller's board — declared intent, not a run. " +
      "Default board: a daemon session's lineage board (`tree:<root>`), else " +
      "the operator's workspace board (`ws:<slug>`). Pass `boardId` to " +
      "override. Leave `owner` absent for a claimable task; `\"self\"` keeps " +
      "it. Declare `verify` (or a later `evidence`) to gate a `done` report.",
    {
      title: z.string().min(1).describe("One-line imperative title."),
      description: z.string().optional().describe("Longer context for whoever claims it."),
      boardId: z
        .string()
        .optional()
        .describe("Explicit board. Omit → the caller's default board."),
      owner: z
        .string()
        .optional()
        .describe(
          "Pre-assign: a sessionId, \"human\", \"operator\", or \"self\". Omit → claimable by anyone.",
        ),
      blockedBy: jsonTolerant(z.array(z.string()))
        .optional()
        .describe("Task ids this depends on. INFORMATIONAL in v1 — nothing schedules off it."),
      verify: jsonTolerant(opaqueSchema(gateInputSchema))
        .optional()
        .describe(
          `Opt-in done-gate (policy_attach's \`gate\` shape): shell (exit 0 = pass) or judge agent. Details: tool_help {name:"task_create", topic:"verify"}`
        ),
      meta: jsonTolerant(z.record(z.string(), z.string()))
        .optional()
        .describe("Free-form provenance (prUrl, worktreePath, actionId, …)."),
    },
    async input => {
      if (!ledger) return notAvailable
      const caller = resolveCaller()
      if ("error" in caller) return jsonContent({ error: caller.error })
      const owner =
        input.owner === "self"
          ? caller.kind === "session"
            ? caller.sessionId
            : "operator"
          : input.owner
      const result = ledger.create(
        {
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
          ...(owner !== undefined ? { owner } : {}),
          ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}),
          ...(input.verify !== undefined ? { verify: input.verify } : {}),
          ...(input.meta !== undefined ? { meta: input.meta } : {}),
        },
        caller,
      )
      return writeResultContent(result)
    },
  )

  // ── task_list ─────────────────────────────────────────────────────
  const compactTaskItem = (t: TaskRecord) => ({
    taskId: t.taskId,
    rev: t.rev,
    title: t.title,
    status: t.status,
    owner: t.owner,
    boardId: t.boardId,
    blockedBy: t.blockedBy,
    hasVerify: t.verify !== undefined,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    closedAt: t.closedAt,
  })

  const taskListSchema = z.object({
    boardId: z
      .string()
      .optional()
      .describe("Board to list. Omit → the caller's default board."),
    status: z.enum(TASK_STATUSES).optional().describe("Filter to one status."),
    includeClosed: z
      .boolean()
      .optional()
      .describe("Include done/failed/cancelled. Default false."),
  })
  type TaskListInput = z.infer<typeof taskListSchema>

  registerBuiltinTool<TaskListInput, TaskRecord[] | McpTextResult>(server, {
    id: "task_list",
    description: "List tasks on a board. Defaults to the caller's own board (a session's " +
      "lineage `tree:<root>`; the operator's `ws:<slug>`) and to OPEN tasks — " +
      "pass `includeClosed` (or a closed `status` filter) for " +
      "done/failed/cancelled. Every record carries its `rev` (needed by " +
      "task_claim/task_update) and, on done, a `verification` stamp saying " +
      "HOW it was closed (self-report vs gate vs human) — read it verbatim. " +
      "COMPACT BY DEFAULT: each task is a slim projection (taskId/rev/title/" +
      "status/owner/boardId/blockedBy/hasVerify/createdAt/updatedAt/closedAt); " +
      "pass `full: true` (or `compact: false`) for the complete record " +
      "(description, verify spec, meta, sessions, verification, …). " +
      "Writes: task_create/task_claim/task_update — if unlisted, " +
      "`tool_search` `select:task_create,task_claim,task_update`.",
    inputSchema: taskListSchema,
    handler: async (input) => {
      if (!ledger) return notAvailable
      const caller = resolveCaller()
      if ("error" in caller) return jsonContent({ error: caller.error })
      return ledger.list(
        {
          ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.includeClosed !== undefined
            ? { includeClosed: input.includeClosed }
            : {}),
        },
        caller,
      )
    },
    transformers: [
      catchErrors(),
      paginatedLegacyList({
        project: compactTaskItem,
        keyOf: t => t.taskId,
        defaultBody: (rows, taskListCall) => {
          const caller = resolveCaller() as TaskCaller
          const boardFilter = (taskListCall ?? {}) as { boardId?: string }
          return {
            boardId: (ledger as TaskLedger).resolveBoardId(caller, boardFilter.boardId),
            tasks: rows,
          }
        },
      }),
    ],
  })

  // ── task_claim ────────────────────────────────────────────────────
  server.tool(
    "task_claim",
    "Claim a claimable task — the CAS verb. Succeeds only if the task is " +
      "pending, has NO owner, and `rev` matches; you become the owner and the " +
      "task flips to in_progress. A lost race answers `{conflict:true, " +
      "current}` — re-read `current` and pick another task (or retry with its " +
      "rev) instead of assuming the claim landed. Claim BEFORE working; " +
      "update when done.",
    {
      taskId: z.string().describe("Task id from task_list / task_create."),
      rev: z
        .number()
        .int()
        .min(0)
        .describe("The rev you last read. A mismatch means someone moved first."),
    },
    async input => {
      if (!ledger) return notAvailable
      const caller = resolveCaller()
      if ("error" in caller) return jsonContent({ error: caller.error })
      return writeResultContent(
        ledger.claim({ taskId: input.taskId, rev: input.rev }, caller),
      )
    },
  )

  // ── task_update ───────────────────────────────────────────────────
  const taskArtifactLinkSchema = z.union([
    z.object({ sessionId: z.string(), key: z.string(), sha256: z.string() }),
    z.object({ approvalId: z.string() }),
  ])

  server.tool(
    "task_update",
    "Update a task (rev-CAS: pass the rev you last read; a mismatch answers " +
      "`{conflict:true, current}`). The OWNER sets status and releases itself " +
      "(`owner:null`); the CREATOR/operator also edit fields, reassign `owner`, " +
      "cancel, and reopen a done task (`status:\"pending\"`). `status:\"done\"` " +
      "on a task with a declared `verify` reports `verifying:true` — the gate " +
      "decides after your turn ends (watch `task:changed`). `evidence:{policyId}` " +
      "closes it off an already-passed policy. `status:\"awaiting_approval\"` " +
      "parks the task on `approvalIds`; a human decision then moves it.",
    {
      taskId: z.string().describe("Task id from task_list / task_create."),
      rev: z.number().int().min(0).describe("The rev you last read."),
      status: z
        .enum(TASK_STATUSES)
        .optional()
        .describe(
          "Target status: pending/in_progress → done|failed; in_progress ⇄ awaiting_approval; → cancelled; done → pending (reopen).",
        ),
      title: z.string().optional().describe("New title (creator/operator)."),
      description: z.string().optional().describe("New description (creator/operator)."),
      blockedBy: jsonTolerant(z.array(z.string()))
        .optional()
        .describe("Replace the informational dependency list (creator/operator)."),
      owner: z
        .union([z.string(), z.null()])
        .optional()
        .describe(
          "Reassign (sessionId / \"human\" / \"operator\") or release with null (owner or creator/operator).",
        ),
      evidence: jsonTolerant(
        opaqueSchema(z.object({ policyId: z.string().min(1) }))
      )
        .optional()
        .describe(
          `With status:"done": an already-PASSED policy standing in for the gate. Details: tool_help {name:"task_update", topic:"evidence"}`
        ),
      note: z
        .string()
        .optional()
        .describe("Free-text note, stamped into meta.note (last-write-wins)."),
      approvalIds: jsonTolerant(z.array(z.string()))
        .optional()
        .describe(
          "Replace the linked approval ids (owner-settable). Required non-empty when moving into awaiting_approval.",
        ),
      artifacts: jsonTolerant(
        opaqueSchema(z.array(taskArtifactLinkSchema))
      )
        .optional()
        .describe(
          `Replace the evidence trail: session artifacts and/or approval payload pointers. Details: tool_help {name:"task_update", topic:"artifacts"}`
        ),
    },
    async input => {
      if (!ledger) return notAvailable
      const caller = resolveCaller()
      if ("error" in caller) return jsonContent({ error: caller.error })
      return writeResultContent(
        ledger.update(
          {
            taskId: input.taskId,
            rev: input.rev,
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}),
            ...(input.owner !== undefined ? { owner: input.owner } : {}),
            ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
            ...(input.approvalIds !== undefined ? { approvalIds: input.approvalIds } : {}),
            ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
          },
          caller,
        ),
      )
    },
  )
}

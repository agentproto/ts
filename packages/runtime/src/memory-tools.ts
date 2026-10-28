/**
 * AIP-72 section 8 store operations as daemon MCP tools: `memory_search`,
 * `memory_list`, `memory_read`, `memory_write`, `memory_supersede`,
 * `memory_archive`, `memory_dismiss`.
 *
 * Write policy (rule 21): anyone may propose; a commit, a supersede, an
 * archive and a dismiss need a caller the daemon treats as the operator or
 * a supervisor. The caller is the one every other gateway tool resolves:
 * no `?callerSessionId=` is the operator bearer (the same split as the MCP
 * events principal, `daemonBearerPrincipal()` vs `sessionPrincipal()`),
 * and a session caller is judged by the spawn role the daemon recorded on
 * its descriptor (`meta.role`, `session-spawn.ts`) against the built-in
 * role lattice (`role.ts`): level at least the supervisor's. A session with
 * no recorded role (spawned before the role was recorded, or an external
 * client) or a pack-carried role only proposes. A session whose agent sets
 * AIP-42 `memory.enabled: false` (`meta.memory: "disabled"`) writes
 * nothing, not even a proposal; it can still read.
 *
 * The store's typed failures come back as structured tool errors
 * (`{ error, message, ... }`), never a bare message.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { registerBuiltinTool } from "@agentproto/mcp-server"
import { paginated, type McpTextResult, type ToolTransformer } from "@agentproto/tool"
import {
  MEMORY_STATUSES,
  MEMORY_TYPES,
  MemoryConflictError,
  MemoryNotFoundError,
  MemorySlugTakenError,
  MemoryTransitionError,
  MemoryValidationError,
  memoryStatus,
  type MemoryDocument,
  type MemoryRecord,
  type MemoryStore,
} from "@agentproto/memory"
import { SUPERVISOR_ROLE, mergeRoleRegistry } from "./role.js"

export type MemoryCaller =
  | { kind: "operator" }
  | { kind: "session"; id: string; role?: string; memoryDisabled?: true }

/** Who is calling: the operator when the connection names no session,
 *  otherwise that session with the role recorded at its spawn. */
export function resolveMemoryCaller(
  callerSessionId: string | undefined,
  metaOf: (id: string) => Record<string, string> | undefined,
): MemoryCaller {
  if (!callerSessionId) return { kind: "operator" }
  const meta = metaOf(callerSessionId)
  return {
    kind: "session",
    id: callerSessionId,
    ...(meta?.role ? { role: meta.role } : {}),
    ...(meta?.memory === "disabled" ? { memoryDisabled: true as const } : {}),
  }
}

/** The commit gate: the operator, or a session whose recorded role sits at
 *  the supervisor's level or above in the built-in role lattice. */
export function memoryCommitAllowed(caller: MemoryCaller): boolean {
  if (caller.kind === "operator") return true
  if (caller.role === undefined) return false
  const role = mergeRoleRegistry()[caller.role]
  return role !== undefined && role.level >= SUPERVISOR_ROLE.level
}

export interface MemoryToolsDeps {
  /** The store this caller reads and writes. */
  store: () => MemoryStore
  caller: MemoryCaller
}

class CommitNotAllowedError extends Error {
  constructor(op: string, caller: MemoryCaller) {
    super(
      `${op} needs the operator or a supervisor; ` +
        (caller.kind === "session"
          ? `session '${caller.id}' has role '${caller.role ?? "unknown"}'.`
          : "this caller is neither.") +
        ' Use memory_write with mode: "propose" instead; an operator or supervisor commits proposals.',
    )
    this.name = "CommitNotAllowedError"
  }
}

/** AIP-42: an agent with `memory.enabled: false` MUST NOT write any memory item. */
class MemoryDisabledError extends Error {
  constructor(op: string) {
    super(`${op}: this session's agent sets memory.enabled: false (AIP-42), so it writes no memory.`)
    this.name = "MemoryDisabledError"
  }
}

function text(payload: unknown, isError = false): McpTextResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  }
}

/** The structured error payload for one failure. */
export function memoryToolError(err: unknown): Record<string, unknown> {
  if (err instanceof CommitNotAllowedError) return { error: "commit_not_allowed", message: err.message }
  if (err instanceof MemoryDisabledError) return { error: "memory_disabled", message: err.message }
  if (err instanceof MemoryConflictError) {
    return {
      error: "conflict",
      message: err.message,
      id: err.id,
      ...(err.expected !== undefined ? { expectedRevision: err.expected } : {}),
      ...(err.actual !== undefined ? { actualRevision: err.actual } : {}),
    }
  }
  if (err instanceof MemoryNotFoundError) {
    return { error: "not_found", message: err.message, what: err.what, id: err.id }
  }
  if (err instanceof MemoryTransitionError) {
    return { error: "invalid_transition", message: err.message, id: err.id, from: err.from, to: err.to }
  }
  if (err instanceof MemorySlugTakenError) {
    return { error: "slug_taken", message: err.message, slug: err.slug, holder: err.holder }
  }
  if (err instanceof MemoryValidationError) {
    return { error: "validation", message: err.message, field: err.field, issues: err.issues }
  }
  return { error: "internal", message: err instanceof Error ? err.message : String(err) }
}

/** Outermost transformer: any thrown failure becomes a structured tool error. */
function memoryErrors(): ToolTransformer<unknown, unknown, McpTextResult> {
  return {
    name: "memoryErrors",
    wrapHandler: handler => async input => {
      try {
        return (await handler(input)) as McpTextResult
      } catch (err) {
        return text(memoryToolError(err), true)
      }
    },
  }
}

/** A memory/v1 item as a tool argument: frontmatter fields plus `body`.
 *  The store validates it (rule 13) and names the offending field. */
const itemSchema = z
  .object({ body: z.string().optional().describe("Markdown body. Default empty.") })
  .passthrough()
  .describe(
    "A memory/v1 item: frontmatter fields (schema, slug, kind, type, title, updated_at, id, " +
      "description, tags, polarity, lifetime, status, provenance, ...) plus `body`.",
  )

function toDocument(item: z.infer<typeof itemSchema>): MemoryDocument {
  return { ...(item as Record<string, unknown>), body: item.body ?? "" } as MemoryDocument
}

const typeFilter = z
  .union([z.enum(MEMORY_TYPES), z.array(z.enum(MEMORY_TYPES))])
  .optional()
  .describe("Only these types (user, feedback, project, reference).")

function compactRecord(record: MemoryRecord) {
  const { item } = record
  return {
    id: item.id,
    type: item.type ?? item.kind,
    ...(item.slug !== undefined ? { slug: item.slug } : {}),
    title: item.title ?? item.name,
    status: memoryStatus(item),
    ...(item.tags !== undefined ? { tags: item.tags } : {}),
    ...(item.updated_at !== undefined ? { updated_at: item.updated_at } : {}),
    revision: record.revision,
    ...(record.proposalId !== undefined ? { proposalId: record.proposalId } : {}),
  }
}

export function registerMemoryTools(server: McpServer, deps: MemoryToolsDeps): void {
  const writable = (op: string): void => {
    if (deps.caller.kind === "session" && deps.caller.memoryDisabled) throw new MemoryDisabledError(op)
  }
  const gate = (op: string): void => {
    writable(op)
    if (!memoryCommitAllowed(deps.caller)) throw new CommitNotAllowedError(op, deps.caller)
  }

  // ── memory_search ─────────────────────────────────────────────
  const searchSchema = z.object({
    query: z.string().min(1).describe("Free-text query over titles, descriptions and bodies."),
    type: typeFilter,
    limit: z.number().int().min(1).max(100).optional().describe("Max hits. Default 20."),
  })
  type SearchInput = z.infer<typeof searchSchema>
  registerBuiltinTool<SearchInput, McpTextResult>(server, {
    id: "memory_search",
    description:
      "Search the AIP-72 memory store. Returns `hits`, each with `source` (`memory` for an item " +
      "of this store, with its `id`), `slug`, `title` and a `snippet`. Only in-force items. " +
      "Read one with memory_read.",
    inputSchema: searchSchema,
    handler: async input => {
      const hits = await deps.store().search(input.query, {
        ...(input.type !== undefined ? { filter: { type: input.type } } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      })
      return text({ hits })
    },
    transformers: [memoryErrors()],
  })

  // ── memory_list ───────────────────────────────────────────────
  const listSchema = z.object({
    type: typeFilter,
    status: z
      .union([z.enum(MEMORY_STATUSES), z.array(z.enum(MEMORY_STATUSES))])
      .optional()
      .describe("Only these statuses. Giving one turns off the in-force default."),
    tags: z
      .array(z.string().min(1))
      .optional()
      .describe('Match any of these tags, e.g. ["global", "project:acme"].'),
    inForce: z
      .boolean()
      .optional()
      .describe("Only in-force items (true) or only the others (false). Default true unless `status` is given."),
    proposals: z.boolean().optional().describe("List pending proposals instead of items."),
  })
  type ListInput = z.infer<typeof listSchema>
  registerBuiltinTool<ListInput, readonly MemoryRecord[]>(server, {
    id: "memory_list",
    description:
      "List AIP-72 memory items, newest first, filtered by type, status, tags and in-force " +
      "(default: in force). `proposals: true` lists pending proposals instead. COMPACT BY " +
      "DEFAULT (id, type, slug, title, status, tags, updated_at, revision); `full: true` " +
      "returns whole records with the body. Paginate with `limit`/`cursor`.",
    inputSchema: listSchema,
    handler: async input =>
      deps.store().list({
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.inForce !== undefined ? { inForce: input.inForce } : {}),
        ...(input.proposals !== undefined ? { proposals: input.proposals } : {}),
      }),
    transformers: [
      memoryErrors(),
      paginated({
        project: compactRecord,
        keyOf: r => r.proposalId ?? r.item.id ?? null,
        maxLimit: 200,
        defaultLimit: 50,
        itemKey: "items",
      }),
    ],
  })

  // ── memory_read ───────────────────────────────────────────────
  const readSchema = z.object({ id: z.string().min(1).describe("Item id.") })
  type ReadInput = z.infer<typeof readSchema>
  registerBuiltinTool<ReadInput, McpTextResult>(server, {
    id: "memory_read",
    description:
      "Read one AIP-72 memory item by id: the whole item with its body, and its `revision` " +
      "(pass it as `ifRevision` to change the item).",
    inputSchema: readSchema,
    handler: async input => {
      const record = await deps.store().read(input.id)
      if (!record) throw new MemoryNotFoundError("item", input.id)
      return text({ revision: record.revision, item: record.item })
    },
    transformers: [memoryErrors()],
  })

  // ── memory_write ──────────────────────────────────────────────
  const writeSchema = z.object({
    item: itemSchema,
    mode: z
      .enum(["propose", "commit"])
      .optional()
      .describe(
        'Default "propose": a proposal is never in force until committed. "commit" needs the ' +
          "operator or a supervisor.",
      ),
    ifRevision: z
      .string()
      .min(1)
      .optional()
      .describe("The revision last read; required to change an existing item."),
    fromProposal: z
      .string()
      .min(1)
      .optional()
      .describe("On a commit: the proposal this commit promotes; it is dropped once the item is written."),
  })
  type WriteInput = z.infer<typeof writeSchema>
  registerBuiltinTool<WriteInput, McpTextResult>(server, {
    id: "memory_write",
    description:
      "Write an AIP-72 memory item. Default mode `propose` records a proposal (any caller). " +
      "Mode `commit` creates or changes an item and is allowed only for the operator or a " +
      "supervisor session; changing an existing item needs its `ifRevision`. Returns the id " +
      "(or proposalId) and the revision.",
    inputSchema: writeSchema,
    handler: async input => {
      const mode = input.mode ?? "propose"
      if (mode === "commit") gate("memory_write commit")
      else writable("memory_write")
      const record = await deps.store().write(toDocument(input.item), {
        mode,
        ...(input.ifRevision !== undefined ? { ifRevision: input.ifRevision } : {}),
        ...(mode === "commit" && input.fromProposal !== undefined ? { fromProposal: input.fromProposal } : {}),
      })
      return text({
        mode,
        ...(record.item.id !== undefined ? { id: record.item.id } : {}),
        ...(record.proposalId !== undefined ? { proposalId: record.proposalId } : {}),
        revision: record.revision,
      })
    },
    transformers: [memoryErrors()],
  })

  // ── memory_supersede ──────────────────────────────────────────
  const supersedeSchema = z.object({
    id: z.string().min(1).describe("The item being replaced."),
    next: itemSchema.describe("The replacing item; it must have a different id (or none, to get one)."),
    ifRevision: z.string().min(1).optional().describe("The old item's revision, as last read."),
  })
  type SupersedeInput = z.infer<typeof supersedeSchema>
  registerBuiltinTool<SupersedeInput, McpTextResult>(server, {
    id: "memory_supersede",
    description:
      "Replace an AIP-72 memory item by a new one: the new item is committed, then the old one " +
      "becomes `superseded` (still readable). Operator or supervisor only; needs the old item's " +
      "`ifRevision`.",
    inputSchema: supersedeSchema,
    handler: async input => {
      gate("memory_supersede")
      const { old, next } = await deps.store().supersede(input.id, toDocument(input.next), {
        ...(input.ifRevision !== undefined ? { ifRevision: input.ifRevision } : {}),
      })
      return text({
        old: { id: old.item.id, status: memoryStatus(old.item), revision: old.revision },
        next: { id: next.item.id, revision: next.revision },
      })
    },
    transformers: [memoryErrors()],
  })

  // ── memory_archive ────────────────────────────────────────────
  const archiveSchema = z.object({
    id: z.string().min(1).describe("Item id."),
    ifRevision: z.string().min(1).optional().describe("The item's revision, as last read."),
  })
  type ArchiveInput = z.infer<typeof archiveSchema>
  registerBuiltinTool<ArchiveInput, McpTextResult>(server, {
    id: "memory_archive",
    description:
      "Retire an AIP-72 memory item: its status becomes `archived`, it stays readable, it is " +
      "no longer in force. Operator or supervisor only; needs `ifRevision`.",
    inputSchema: archiveSchema,
    handler: async input => {
      gate("memory_archive")
      const record = await deps.store().archive(input.id, {
        ...(input.ifRevision !== undefined ? { ifRevision: input.ifRevision } : {}),
      })
      return text({ id: record.item.id, status: memoryStatus(record.item), revision: record.revision })
    },
    transformers: [memoryErrors()],
  })

  // ── memory_dismiss ────────────────────────────────────────────
  const dismissSchema = z.object({
    proposalId: z.string().min(1).describe("The pending proposal to drop."),
  })
  type DismissInput = z.infer<typeof dismissSchema>
  registerBuiltinTool<DismissInput, McpTextResult>(server, {
    id: "memory_dismiss",
    description:
      "Drop a pending AIP-72 memory proposal that will not be committed. Nothing in force is " +
      "erased. Operator or supervisor only.",
    inputSchema: dismissSchema,
    handler: async input => {
      gate("memory_dismiss")
      await deps.store().dismiss(input.proposalId)
      return text({ proposalId: input.proposalId, dismissed: true })
    },
    transformers: [memoryErrors()],
  })
}

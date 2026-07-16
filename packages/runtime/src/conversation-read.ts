/**
 * `conversation_read` — read the provider-native conversation behind ANY
 * session, agent-cli or PTY alike. A session is just an attachment to a
 * conversation (see conversation-store.ts); this is the read path that
 * works no matter which attachment happened to be live.
 *
 * Resolution is a ladder, strongest evidence first — see
 * `resolveConversationId` below. Finding nothing (a bash/vim PTY) is a
 * normal outcome, not an error; finding more than one candidate returns
 * the list rather than guessing (same invariant `discover` itself upholds).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"
import { CONVERSATION_STORES, type ConversationCandidate } from "./conversation-store.js"
import { renderMarkdown, renderJson, type ExportedSession } from "./transcript-export.js"

/** Binary (argv[0] basename) → `CONVERSATION_STORES` key. Only needed for
 *  PTY sessions with no `adapterSlug` recorded — an agent-cli session's
 *  `adapterSlug` already IS the store key. */
const BINARY_TO_STORE_KEY: Record<string, string> = {
  claude: "claude-code",
  hermes: "hermes",
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/")
  return idx === -1 ? path : path.slice(idx + 1)
}

/** `desc.adapterSlug` when set (agent-cli sessions record the store key
 *  directly); otherwise infer from argv[0]'s basename for a bare PTY.
 *  Returns a key only when `CONVERSATION_STORES` actually has an entry
 *  for it — an unrecognized adapter/binary is the same as "no store". */
function knownStoreKey(desc: Pick<SessionDescriptor, "adapterSlug" | "argv">): string | undefined {
  const key = desc.adapterSlug ?? (desc.argv?.[0] ? BINARY_TO_STORE_KEY[basename(desc.argv[0])] : undefined)
  return key !== undefined && CONVERSATION_STORES[key] ? key : undefined
}

/** Pulls the id out of `--resume <id>` / `-r <id>` in a PTY's launch argv —
 *  the ONLY link back to its conversation for a PTY that was hand-resumed
 *  outside agentproto (e.g. `claude --resume <uuid>` typed directly). */
function parseResumeArgv(argv: SessionDescriptor["argv"]): string | undefined {
  if (!argv) return undefined
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--resume" || argv[i] === "-r") return argv[i + 1]
  }
  return undefined
}

type LadderResult =
  | { kind: "found"; conversationId: string; storeKey: string }
  | { kind: "ambiguous"; candidates: ConversationCandidate[] }
  | { kind: "none"; reason: string }

/** The conversation-id discovery ladder, strongest evidence first. Steps 1
 *  and 2 are exact binds and never degrade to a guess; step 3 auto-picks
 *  ONLY when discovery turns up exactly one candidate — more than one goes
 *  back to the caller (see conversation-store.ts's invariants). */
async function resolveConversationId(desc: SessionDescriptor): Promise<LadderResult> {
  // Step 1 — the ACP-level conversation id, recorded at spawn time. Exact.
  if (desc.adapterSessionId) {
    const storeKey = knownStoreKey(desc)
    if (!storeKey) {
      return {
        kind: "none",
        reason:
          `session has adapter conversation id "${desc.adapterSessionId}" but no known ` +
          `conversation store for adapter "${desc.adapterSlug ?? "(unknown)"}"`,
      }
    }
    return { kind: "found", conversationId: desc.adapterSessionId, storeKey }
  }

  // Step 2 — a `--resume`/`-r <id>` baked into a PTY's own argv. Exact:
  // rescues an orphan PTY whose only link to its conversation is the id
  // in its launch argv (no adapterSessionId was ever recorded for it).
  const resumeId = parseResumeArgv(desc.argv)
  if (resumeId) {
    const storeKey = knownStoreKey(desc)
    if (storeKey) return { kind: "found", conversationId: resumeId, storeKey }
  }

  // Step 3 — ask the provider's native store what it has for this cwd,
  // scoped to since the session started. Auto-pick only a singleton.
  const storeKey = knownStoreKey(desc)
  if (!storeKey) {
    return {
      kind: "none",
      reason: desc.pty
        ? "no known agent binary or --resume argv on this PTY — likely a plain terminal " +
          "(bash, vim, …) with no underlying conversation"
        : "no known conversation store for this session (no adapterSlug, and argv[0] " +
          "isn't a recognized agent binary)",
    }
  }
  if (!desc.cwd) {
    return { kind: "none", reason: "session has no recorded cwd; cannot search the conversation store" }
  }
  const store = CONVERSATION_STORES[storeKey]!
  const candidates = await store.discover({ cwd: desc.cwd, since: desc.startedAt })
  if (candidates.length === 0) {
    return {
      kind: "none",
      reason: `no conversation found in the "${storeKey}" store for this session's cwd/time window`,
    }
  }
  if (candidates.length === 1) {
    return { kind: "found", conversationId: candidates[0]!.conversationId, storeKey }
  }
  return { kind: "ambiguous", candidates }
}

export interface ConversationReadInput {
  /** agentproto session id (sess_xxx) or session name. */
  idOrName: string
  format?: "markdown" | "json"
}

export interface ConversationReadResult {
  /** The rendered conversation, or `null` when none was found/readable —
   *  a normal outcome (e.g. a bash PTY), not an error. */
  conversation: ExportedSession | null
  conversationId?: string
  adapter?: string
  format?: string
  /** Rendered markdown/json transcript — set alongside `conversation`. */
  content?: string
  /** Plain-English explanation, set whenever `conversation` is null. */
  reason?: string
  /** Set only for the ambiguous-discovery outcome — candidates instead of
   *  a guess. `conversation` is null alongside this. */
  candidates?: ConversationCandidate[]
}

/** Core logic shared by the MCP tool and the HTTP route below — resolves
 *  a session (alive or historical) to its provider-native conversation and
 *  renders it. Read-only: never spawns, kills, resumes, or writes. */
export async function readConversation(
  registry: SessionsRegistry,
  input: ConversationReadInput,
): Promise<ConversationReadResult> {
  const desc = registry.findByIdOrName(input.idOrName)
  if (!desc) {
    return { conversation: null, reason: `session "${input.idOrName}" not found` }
  }

  const resolved = await resolveConversationId(desc)
  if (resolved.kind === "ambiguous") {
    return {
      conversation: null,
      candidates: resolved.candidates,
      reason: "multiple candidate conversations found; specify one",
    }
  }
  if (resolved.kind === "none") {
    return { conversation: null, reason: resolved.reason }
  }

  const store = CONVERSATION_STORES[resolved.storeKey]
  if (!store) {
    return {
      conversation: null,
      reason: `no conversation store registered for adapter "${resolved.storeKey}"`,
    }
  }

  const format = input.format ?? "markdown"
  try {
    const session = await store.read(resolved.conversationId, desc.cwd)
    const content = format === "json" ? renderJson(session) : renderMarkdown(session)
    return {
      conversation: session,
      conversationId: resolved.conversationId,
      adapter: resolved.storeKey,
      format,
      content,
    }
  } catch (err) {
    return {
      conversation: null,
      conversationId: resolved.conversationId,
      adapter: resolved.storeKey,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface ConversationReadOps {
  registry: SessionsRegistry
}

/**
 * Register the `conversation_read` MCP tool.
 *
 * Mirrors `registerExportSessionTool`'s registry-access + text-content
 * return pattern, but works on any session kind (agent-cli or PTY) and
 * discovers the conversation id itself instead of requiring one of
 * `adapterSessionId` / an explicit override.
 */
export function registerConversationReadTool(server: McpServer, ops: ConversationReadOps): void {
  server.tool(
    "conversation_read",
    "Read the provider-native conversation behind a session, whether it's an agent-cli " +
      "session or a plain PTY. Resolves the conversation id via (in order) the recorded " +
      "adapterSessionId, a --resume/-r id baked into the session's argv, or a scoped search " +
      "of the provider's own conversation store — then renders it the same way as " +
      "agent_export. Read-only; never spawns, kills, resumes, or writes. A session with no " +
      "underlying conversation (e.g. a bash/vim PTY) returns `{ conversation: null, reason }` " +
      "— that is a normal, expected outcome, not an error. When discovery finds more than one " +
      "candidate conversation it returns the candidate list instead of guessing.",
    {
      idOrName: z.string().describe("agentproto session id (sess_xxx) or session name."),
      format: z
        .enum(["markdown", "json"])
        .optional()
        .describe(
          "Output format for the rendered transcript when a conversation is found. " +
            "`markdown` (default) or `json`.",
        ),
    },
    async input => {
      const result = await readConversation(ops.registry, {
        idOrName: input.idOrName,
        ...(input.format ? { format: input.format } : {}),
      })
      if (result.conversation) {
        return { content: [{ type: "text" as const, text: result.content ?? "" }] }
      }
      const isUnknownSession = (result.reason ?? "").includes("not found")
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                conversation: null,
                reason: result.reason,
                ...(result.candidates ? { candidates: result.candidates } : {}),
              },
              null,
              2,
            ),
          },
        ],
        ...(isUnknownSession ? { isError: true as const } : {}),
      }
    },
  )
}

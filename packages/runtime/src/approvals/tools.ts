/**
 * MCP tools over the approvals engine (`engine.ts`):
 *   approval_request / approval_get / approval_wait / approval_consume
 *
 * Model-visible (no `_meta.ui.visibility` restriction) — an agent may
 * request and consume, never decide. Registered unconditionally on the
 * root `/mcp` server (`index.ts`); a spawned session identifies itself via
 * `callerSessionId` (the same `?callerSessionId=` plumbing
 * `registerCommandTools` uses), an unidentified caller is the operator —
 * mirrors `task-tools.ts`'s "root /mcp endpoint is operator context" rule,
 * except here a daemon-spawned session's self-ref MCP connection DOES
 * carry an identity, so it gets `{sessionId}` instead of always falling
 * back to the operator.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { jsonTolerant } from "../json-tolerant.js"
import { ApprovalError } from "./types.js"
import { approvalCardResourceUri } from "./card.js"
import type { ApprovalsEngine } from "./engine.js"
import type { ApprovalRecord, ApprovalRequester } from "./types.js"

export interface RegisterApprovalToolsOptions {
  /** Absent → the tools register but answer a structured "approvals engine
   *  not available" error (handshake-safe, same convention as
   *  `registerTaskTools`). */
  engine?: ApprovalsEngine
  /** `?callerSessionId=` on this `/mcp` connection — set when the caller is
   *  a daemon-spawned session using its self-ref `mcpServers` entry. Absent
   *  ⇒ the operator (a human driving the daemon directly, or an
   *  unidentified client). */
  callerSessionId?: string
}

type McpTextResult = { content: Array<{ type: "text"; text: string }> }

function jsonContent(payload: unknown): McpTextResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] }
}

/** Only include `_meta.ui.resourceUri` while the approval is still
 *  pending — once decided the card resource is no longer re-registered on
 *  a fresh `/mcp` connection (see `index.ts`'s per-request loop), so
 *  advertising it past that point would point at a resource that may 404. */
function withCardMeta(record: ApprovalRecord): Record<string, unknown> {
  return {
    ...record,
    ...(record.status === "pending"
      ? { _meta: { ui: { resourceUri: approvalCardResourceUri(record.id) } } }
      : {}),
  }
}

export function registerApprovalTools(server: McpServer, opts: RegisterApprovalToolsOptions): void {
  const { engine, callerSessionId } = opts
  const requester = (): ApprovalRequester => (callerSessionId ? { sessionId: callerSessionId } : { operator: true })
  const notAvailable = jsonContent({ error: "approvals engine not available" })

  server.tool(
    "approval_request",
    "Raise a human approval gate before an irreversible action (send/spend/publish/…). " +
      "Pins the exact `payload` (sha256, canonical JSON) behind a human decision — " +
      "`approval_consume` later re-hashes and rejects any drift. Returns immediately " +
      "with status \"pending\"; poll `approval_get` or block on `approval_wait`. " +
      "Nothing you can call decides it — only a human, through a declared channel.",
    {
      kind: z.string().min(1).describe('Free string naming the action class, e.g. "send", "spend", "publish".'),
      title: z.string().min(1).describe("One line, UI-ready: what a human is deciding."),
      preview: jsonTolerant(z.unknown()).describe("JSON-ready preview for a UI to render (opaque to the engine)."),
      payload: jsonTolerant(z.unknown()).describe(
        "The exact payload the gated action will run with. Hashed (sha256, canonical JSON) and pinned — " +
          "`approval_consume` must pass byte-identical content back.",
      ),
      taskId: z.string().optional().describe("Optional link to a task (informational in this lane)."),
      appId: z.string().optional().describe("Optional owning app id."),
      expiresAt: z.iso.datetime().optional().describe("Optional ISO timestamp after which a pending request auto-expires."),
    },
    async input => {
      if (!engine) return notAvailable
      try {
        const record = engine.request(
          {
            kind: input.kind,
            title: input.title,
            preview: input.preview,
            payload: input.payload,
            ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
            ...(input.appId !== undefined ? { appId: input.appId } : {}),
            ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          },
          requester(),
        )
        return jsonContent(withCardMeta(record))
      } catch (err) {
        return jsonContent({ error: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  server.tool(
    "approval_get",
    "Read one approval's current state by id.",
    { id: z.string().min(1) },
    async input => {
      if (!engine) return notAvailable
      const record = engine.get(input.id)
      if (!record) return jsonContent({ error: "approval_not_found" })
      return jsonContent(withCardMeta(record))
    },
  )

  server.tool(
    "approval_wait",
    "Block (bounded, 45s max) until this approval leaves pending — approved, denied, or " +
      "expired — or the timeout elapses, whichever comes first. Returns the approval's " +
      "current state either way; check `status`, don't assume the wait means decided.",
    {
      id: z.string().min(1),
      timeoutMs: z.number().int().min(0).max(45_000).optional().describe("Default and hard ceiling: 45000."),
    },
    async input => {
      if (!engine) return notAvailable
      const timeoutMs = Math.min(input.timeoutMs ?? 45_000, 45_000)
      const record = await engine.wait(input.id, timeoutMs)
      if (!record) return jsonContent({ error: "approval_not_found" })
      return jsonContent(withCardMeta(record))
    },
  )

  server.tool(
    "approval_consume",
    "Atomically mark an APPROVED approval consumed, iff `payload` hashes to the pinned " +
      "value and it was not consumed before, and you are the original requester. Call this " +
      "immediately before the irreversible action and do not perform it if this throws.",
    {
      id: z.string().min(1),
      payload: jsonTolerant(z.unknown()).describe("The exact payload — must match what `approval_request` pinned."),
    },
    async input => {
      if (!engine) return notAvailable
      try {
        const record = engine.consume(input.id, requester(), input.payload)
        return jsonContent(record)
      } catch (err) {
        if (err instanceof ApprovalError) return jsonContent({ error: err.code, message: err.message })
        return jsonContent({ error: err instanceof Error ? err.message : String(err) })
      }
    },
  )
}

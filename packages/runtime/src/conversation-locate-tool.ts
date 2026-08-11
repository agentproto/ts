/**
 * `conversation_locate` — the bidirectional session ↔ native-transcript
 * lookup, exposed to agents as an MCP tool (the CLI already has it as
 * `agentproto conversation locate`, see packages/cli/src/commands/conversation.ts).
 *
 * Pure local-filesystem read over the persisted, append-only
 * `conversations.jsonl` per workspace bucket (conversation-index.ts) — no
 * daemon round-trip. A target is tried as an agentproto sessionId first
 * (forward), then as a native jsonl path (reverse, root conversation OR a
 * subagent transcript). Nothing found is a normal outcome (`found: false`),
 * not an MCP error — it's the exact question `session_gc({forget:true})`
 * leaves open, where the session descriptor is gone but the on-disk
 * transcript isn't.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { resolve } from "node:path"
import { z } from "zod"
import { BUCKETS_ROOT, listBuckets } from "./workspace-buckets.js"
import {
  locateConversationByNativePath,
  locateConversationBySessionId,
  type ConversationIndexRecord,
} from "./conversation-index.js"

export interface ConversationLocateInput {
  /** agentproto session id (sess_xxx) OR a native transcript jsonl path. */
  target: string
}

export interface ConversationLocateResult {
  found: boolean
  workspace?: string
  record?: ConversationIndexRecord
  /** Set when the reverse lookup matched a subagent transcript rather than
   *  the root conversation file — the path that actually matched. */
  matchedSubagentPath?: string
  matchedBy?: "sessionId" | "nativePath"
  /** Plain-English explanation, set whenever `found` is false. */
  reason?: string
}

/** Core lookup shared by the MCP tool — mirrors the CLI's `runLocate` logic
 *  exactly: sessionId first, then native path. Read-only. */
export async function locateConversation(
  input: ConversationLocateInput,
): Promise<ConversationLocateResult> {
  const bucketsRoot = BUCKETS_ROOT()
  const buckets = () => listBuckets(bucketsRoot)

  const bySession = await locateConversationBySessionId(bucketsRoot, buckets, input.target)
  if (bySession) {
    return {
      found: true,
      workspace: bySession.workspace,
      record: bySession.record,
      matchedBy: "sessionId",
    }
  }

  const byPath = await locateConversationByNativePath(bucketsRoot, buckets, resolve(input.target))
  if (byPath) {
    return {
      found: true,
      workspace: byPath.workspace,
      record: byPath.record,
      matchedBy: "nativePath",
      ...(byPath.matchedSubagentPath ? { matchedSubagentPath: byPath.matchedSubagentPath } : {}),
    }
  }

  return {
    found: false,
    reason:
      `no record for "${input.target}" in any workspace bucket ` +
      `(tried as a sessionId, then as a native jsonl path)`,
  }
}

/** Register the `conversation_locate` MCP tool. Stateless — bucketsRoot and
 *  the bucket lister resolve straight off HOME, same as the CLI verb. */
export function registerConversationLocateTool(server: McpServer): void {
  server.tool(
    "conversation_locate",
    "Bidirectional lookup between an agentproto session and its provider-native " +
      "conversation transcript. Given an agentproto session id (sess_xxx) it finds the " +
      "original native conversation file the session is attached to (forward); given a " +
      "native transcript path (a claude-code jsonl, root OR subagent) it finds the owner " +
      "session/workspace (reverse). Scans every workspace bucket's persisted index " +
      "(~/.agentproto/workspaces/<slug>/conversations.jsonl) — no daemon round-trip. " +
      "Useful after session_gc({forget:true}) when the session descriptor is gone but the " +
      "on-disk transcript still exists. Nothing found returns `{ found: false, reason }` " +
      "— a normal outcome, not an error. Read-only.",
    {
      target: z
        .string()
        .describe("agentproto session id (sess_xxx) or a native transcript jsonl path."),
    },
    async input => {
      const result = await locateConversation({ target: input.target })
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
    },
  )
}

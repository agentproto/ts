/**
 * `agentproto conversation locate <sessionId | native-jsonl-path> [--json]`
 *
 * Answers the retrieval ask conversation-index.ts exists for: given an
 * agentproto session, find the original claude/hermes conversation file
 * (forward), or given a native transcript path, find the agentproto
 * session that owns it (reverse).
 *
 * Pure local filesystem read over the persisted, append-only
 * `conversations.jsonl` per workspace bucket (`@agentproto/runtime`'s
 * conversation-index module) — no daemon round-trip needed, same as
 * `agentproto worktree ls`. Scans every bucket under
 * `~/.agentproto/workspaces/` since the caller doesn't have to know which
 * workspace a session landed in.
 */
import { resolve } from "node:path"
import {
  BUCKETS_ROOT,
  listBuckets,
  locateConversationByNativePath,
  locateConversationBySessionId,
  type ConversationIndexRecord,
} from "@agentproto/runtime"

const USAGE = `agentproto conversation — locate the native transcript behind a session

Usage:
  agentproto conversation locate <sessionId>            forward: session → native path + subagents
  agentproto conversation locate <path/to/*.jsonl>       reverse: native path → owning session
  agentproto conversation locate <arg> --json

Scans every workspace bucket's conversations.jsonl
(~/.agentproto/workspaces/<slug>/conversations.jsonl) — the persisted,
append-only memo of the session ↔ native-transcript link. Tries the
argument as a sessionId first; if nothing matches, retries it as a native
jsonl path (root conversation OR a subagent transcript).

Examples:
  agentproto conversation locate sess_ab12cd34
  agentproto conversation locate ~/.claude/projects/-Users-me-app/11111111-....jsonl
  agentproto conversation locate sess_ab12cd34 --json
`

export async function runConversation(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  if (sub === "locate") return runLocate(args.slice(1))

  if (!sub) {
    process.stdout.write(USAGE)
    return 0
  }
  process.stderr.write(
    `agentproto conversation: unknown subcommand "${sub}"\n  Known: locate\n`,
  )
  return 2
}

interface LocateResult {
  workspace: string
  record: ConversationIndexRecord
  matchedSubagentPath?: string
  matchedBy: "sessionId" | "nativePath"
}

async function runLocate(args: readonly string[]): Promise<number> {
  const json = args.includes("--json")
  const positionals = args.filter(a => !a.startsWith("-"))
  const arg = positionals[0]
  if (!arg) {
    process.stderr.write(
      "agentproto conversation locate: missing <sessionId | native-jsonl-path>\n\n" + USAGE,
    )
    return 2
  }

  const bucketsRoot = BUCKETS_ROOT()
  const buckets = () => listBuckets(bucketsRoot)

  let result: LocateResult | undefined
  const bySession = await locateConversationBySessionId(bucketsRoot, buckets, arg)
  if (bySession) {
    result = { ...bySession, matchedBy: "sessionId" }
  } else {
    const byPath = await locateConversationByNativePath(bucketsRoot, buckets, resolve(arg))
    if (byPath) result = { ...byPath, matchedBy: "nativePath" }
  }

  if (!result) {
    process.stderr.write(
      `agentproto conversation locate: no record for "${arg}" in any workspace bucket ` +
        `(tried as a sessionId, then as a native jsonl path).\n`,
    )
    return 1
  }

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }

  printHuman(result)
  return 0
}

function printHuman(result: LocateResult): void {
  const { record, workspace, matchedSubagentPath, matchedBy } = result
  const lines: string[] = []
  lines.push(
    matchedBy === "sessionId"
      ? `Session:    ${record.sessionId}`
      : `Session:    ${record.sessionId}  (matched via ${
          matchedSubagentPath ? "a subagent transcript" : "the native path"
        })`,
  )
  lines.push(`Workspace:  ${workspace}`)
  lines.push(`Adapter:    ${record.adapterSlug} (${record.adapterSessionId})`)
  lines.push(`cwd:        ${record.cwd}`)
  if (record.native) {
    if (record.native.kind === "claude-jsonl") {
      lines.push(`Native:     claude-jsonl`)
      lines.push(`  path:       ${record.native.path}`)
      lines.push(`  subagents:  ${record.native.subagents.length}`)
      for (const p of record.native.subagents) {
        lines.push(`    - ${p}${p === matchedSubagentPath ? "  ← matched" : ""}`)
      }
    } else {
      lines.push(`Native:     hermes-sqlite`)
      lines.push(`  dbPath:     ${record.native.dbPath}`)
      lines.push(`  rowId:      ${record.native.rowId}`)
    }
  } else {
    lines.push(`Native:     (none — adapter has no known native store)`)
  }
  lines.push(`Transcript: ${record.agentprotoTranscript}`)
  if (record.title) lines.push(`Title:      ${record.title}`)
  lines.push(`Started:    ${record.startedAt}`)
  if (record.endedAt) lines.push(`Ended:      ${record.endedAt}`)
  process.stdout.write(lines.join("\n") + "\n")
}

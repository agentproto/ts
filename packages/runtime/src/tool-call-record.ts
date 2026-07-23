/**
 * ONE normalized shape for a finished tool/command call — the unification
 * target for the two disjoint logs this repo has today: `recordCommand`'s
 * `CommandLogEntry` (command-log.ts, the `command_execute` proxy path) and
 * `transcript-writer.ts`'s per-kind `tool-call`/`tool-result` records (an
 * agent's own in-process Bash/Edit/…). Both writers append a
 * `ToolCallRecord` line (tagged `kind: "tool-call-record"` on disk — see
 * tool-call-log.ts) to the SAME per-session `events.jsonl` they already
 * own, so `tool_calls_list` can read either without a new store.
 *
 * Deliberately excludes session-level provenance (`harness`, `origin`,
 * `callerSessionId`): that already lives once on the owning
 * `SessionDescriptor` (see sessions.ts), and duplicating it onto every
 * call-level line would just be a snapshot that can drift. `tool_calls_list`
 * joins it in at read time from the descriptor instead.
 */

export interface ToolCallRecord {
  /** The session (command or agent-cli) whose events.jsonl this call was
   *  written into. */
  sessionId: string
  /** Tool/command name — an MCP tool name for the proxy path
   *  ("command_execute"), or an ACP tool name for the in-agent path
   *  ("Bash", "Read", "Edit", …). */
  tool: string
  /** Shell command string, when this call is shell-shaped. Present for
   *  every proxy call; only present in-agent when `extractCommandArgs`
   *  recognizes the tool's `arguments` as `{command, args?}` (a Bash-style
   *  tool) — every other in-agent tool (Read, Edit, …) legitimately has no
   *  shell command, so this stays absent rather than guessing. */
  command?: string
  args?: string[]
  /** Process exit code — only meaningful for the proxy path, which runs a
   *  real subprocess. Absent for in-agent calls (ACP has no exit-code
   *  concept, only `isError`). */
  exitCode?: number
  isError?: boolean
  durationMs?: number
  ts: string
}

/**
 * Best-effort extraction of a shell-shaped `{command, args}` out of an
 * arbitrary, harness-shaped tool-call `arguments` blob (typed `unknown` at
 * the ACP boundary — see `AgentStreamEvent.arguments` in sessions.ts).
 * Only recognizes the `{command: string, args?: string[]}` shape a
 * Bash-style tool sends; every other tool shape returns `{}` rather than
 * guessing, per AGENTS.md's "no silent caps" ethic applied to normalization
 * (don't claim a `command` this didn't actually see).
 */
export function extractCommandArgs(input: unknown): { command?: string; args?: string[] } {
  if (!input || typeof input !== "object") return {}
  const obj = input as Record<string, unknown>
  const command = typeof obj.command === "string" ? obj.command : undefined
  if (command === undefined) return {}
  const argv =
    Array.isArray(obj.args) && obj.args.every(a => typeof a === "string")
      ? (obj.args as string[])
      : undefined
  return argv ? { command, args: argv } : { command }
}

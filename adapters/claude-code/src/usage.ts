/**
 * Real per-turn token usage for a claude-code session, read from Claude
 * Code's own transcript JSONL.
 *
 * Over ACP, claude-agent-acp's `usage_update` only carries cost + context
 * size/used — no input/output split and no prompt-cache split. Claude Code
 * itself writes every API response's `usage` block into
 * `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<slug(cwd)>/<sessionId>.jsonl`
 * (Task sub-agents into `<sessionId>/subagents/*.jsonl` next to it), so the
 * daemon's `readUsage` hook sums those instead.
 *
 * One API response is written as SEVERAL lines (one per content block), each
 * repeating the same `message.id` and the same `usage` — so usage is keyed by
 * message id (last line wins) and summed once per response.
 *
 * Reads are incremental: the daemon polls this every few seconds while the
 * session runs, so each file keeps a byte offset and only the appended tail
 * is parsed on the next call.
 */

import { open, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** Cumulative token usage for one claude-code session. Fields are omitted
 *  when no response reported them (never zero-filled). */
export interface ClaudeCodeUsage {
  tokensIn?: number
  tokensOut?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

interface ResponseUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

/** Per-response usage keyed by message id, plus the parse cursor. */
interface FileState {
  /** Byte offset just past the last complete (newline-terminated) line. */
  offset: number
  responses: Map<string, ResponseUsage>
  anon: number
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined

/** Fold one JSONL line into `state`. Non-assistant / usage-less / malformed
 *  lines are ignored. */
function foldLine(state: FileState, line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return
  let entry: unknown
  try {
    entry = JSON.parse(trimmed)
  } catch {
    return
  }
  if (!entry || typeof entry !== "object") return
  const e = entry as {
    type?: unknown
    requestId?: unknown
    message?: { id?: unknown; usage?: Record<string, unknown> }
  }
  if (e.type !== "assistant") return
  const usage = e.message?.usage
  if (!usage || typeof usage !== "object") return
  const details = usage.output_tokens_details as Record<string, unknown> | undefined
  const r: ResponseUsage = {}
  const input = num(usage.input_tokens)
  const output = num(usage.output_tokens)
  const cacheRead = num(usage.cache_read_input_tokens)
  const cacheWrite = num(usage.cache_creation_input_tokens)
  const reasoning = num(details?.thinking_tokens) ?? num(details?.reasoning_tokens)
  if (input !== undefined) r.input = input
  if (output !== undefined) r.output = output
  if (cacheRead !== undefined) r.cacheRead = cacheRead
  if (cacheWrite !== undefined) r.cacheWrite = cacheWrite
  if (reasoning !== undefined) r.reasoning = reasoning
  const key =
    typeof e.message?.id === "string"
      ? e.message.id
      : typeof e.requestId === "string"
        ? `req:${e.requestId}`
        : `anon:${state.anon++}`
  state.responses.set(key, r)
}

function newState(): FileState {
  return { offset: 0, responses: new Map(), anon: 0 }
}

/** Parse a whole transcript's text in one go. Exposed for tests + one-shot
 *  callers; the incremental reader below folds lines through the same path. */
export function parseClaudeCodeTranscriptUsage(text: string): ClaudeCodeUsage | null {
  const state = newState()
  for (const line of text.split("\n")) foldLine(state, line)
  return sumResponses([state])
}

function sumResponses(states: readonly FileState[]): ClaudeCodeUsage | null {
  const out: ClaudeCodeUsage = {}
  let any = false
  const add = (k: keyof ClaudeCodeUsage, v: number | undefined): void => {
    if (v === undefined) return
    out[k] = (out[k] ?? 0) + v
  }
  for (const state of states) {
    for (const r of state.responses.values()) {
      any = true
      add("tokensIn", r.input)
      add("tokensOut", r.output)
      add("cacheReadTokens", r.cacheRead)
      add("cacheWriteTokens", r.cacheWrite)
      add("reasoningTokens", r.reasoning)
    }
  }
  return any ? out : null
}

/** Incremental parse state, keyed by absolute file path. */
const fileStates = new Map<string, FileState>()

/** Bring `path`'s state up to date with the file on disk. Returns undefined
 *  when the file doesn't exist. */
async function refreshFile(path: string): Promise<FileState | undefined> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    fileStates.delete(path)
    return undefined
  }
  let state = fileStates.get(path)
  // Shrunk = rewritten (e.g. a resumed transcript), start over.
  if (!state || size < state.offset) {
    state = newState()
    fileStates.set(path, state)
  }
  if (size === state.offset) return state
  const start = state.offset
  const fh = await open(path, "r")
  try {
    const len = size - start
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, start)
    // An overlapping call (turn-end read racing the live poller) already
    // consumed this range; folding is keyed so it'd be harmless, but the
    // offset must not advance twice.
    if (state.offset !== start || fileStates.get(path) !== state) return state
    // Only consume through the last newline: anything after it is a line
    // still being written, re-read whole on the next call (cutting on a
    // byte boundary could also split a multi-byte character).
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (end < 0) return state
    state.offset = start + end + 1
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      foldLine(state, line)
    }
  } finally {
    await fh.close()
  }
  return state
}

/** Transcript paths for `sessionId`: the main JSONL plus any Task
 *  sub-agent transcripts beside it. */
async function transcriptPaths(projectDir: string, sessionId: string): Promise<string[]> {
  const paths = [join(projectDir, `${sessionId}.jsonl`)]
  const subDir = join(projectDir, sessionId, "subagents")
  try {
    for (const name of (await readdir(subDir)).sort()) {
      if (name.endsWith(".jsonl")) paths.push(join(subDir, name))
    }
  } catch {
    // no sub-agents
  }
  return paths
}

/** Claude Code's project-dir slug: every non-alphanumeric char → "-". */
export function claudeCodeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

/**
 * Best-effort cumulative usage for a claude-code session. Looks under the
 * session's isolated `configDir` first, then `~/.claude`. Returns null when
 * no transcript (or no usage in it) is found; never throws.
 */
export async function readClaudeCodeUsage(
  sessionId: string,
  ctx?: { cwd?: string; configDir?: string },
): Promise<ClaudeCodeUsage | null> {
  try {
    if (!ctx?.cwd) return null
    const slug = claudeCodeProjectSlug(ctx.cwd)
    const bases = [
      ...(ctx.configDir ? [ctx.configDir] : []),
      resolve(homedir(), ".claude"),
    ]
    for (const base of bases) {
      const projectDir = resolve(base, "projects", slug)
      const states: FileState[] = []
      for (const path of await transcriptPaths(projectDir, sessionId)) {
        const state = await refreshFile(path)
        if (state) states.push(state)
      }
      // The main transcript decides which base is the session's store.
      if (states.length > 0) return sumResponses(states)
    }
    return null
  } catch {
    return null
  }
}

/** Test hook: drop the incremental parse cache. */
export function resetClaudeCodeUsageCache(): void {
  fileStates.clear()
}

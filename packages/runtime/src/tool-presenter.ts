/**
 * Turns a raw tool-call name + args (and its eventual result) into a short,
 * human-readable line for ring-buffer / CLI / transcript rendering. Without
 * this, every tool call renders as a bare `[tool] view` with no args and no
 * outcome — this module is the one place that knows how to summarize both.
 */

const SALIENT_ARG_KEYS = [
  "file_path",
  "path",
  "filePath",
  "file",
  "command",
  "pattern",
  "query",
  "q",
  "url",
  "todos",
  "description",
  "prompt",
] as const

const MAX_CALL_LENGTH = 120
const MAX_RESULT_LENGTH = 160

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function formatArgValue(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`
  if (isRecord(value)) return JSON.stringify(value)
  return String(value)
}

function pickSalientArg(args: Record<string, unknown>): string | null {
  for (const key of SALIENT_ARG_KEYS) {
    const value = args[key]
    if (value !== undefined && value !== null && value !== "") {
      return formatArgValue(value)
    }
  }
  return null
}

type BespokeFormatter = (args: Record<string, unknown>) => string

function subagentSummary(args: Record<string, unknown>): string {
  const description =
    typeof args.description === "string"
      ? args.description
      : typeof args.prompt === "string"
        ? args.prompt
        : "subagent"
  return `↳ subagent: ${truncate(description, MAX_CALL_LENGTH)}`
}

// Bespoke one-liners for control tools where the generic arg-sniffing
// below would either miss the point (ScheduleWakeup's payload isn't a
// file/command/pattern) or just repeat the tool name pointlessly
// (TodoWrite, ExitPlanMode carry no salient single-value arg).
const BESPOKE_TOOLS: Record<string, BespokeFormatter> = {
  schedulewakeup: (args) => {
    const delay = args.delaySeconds ?? args.delay ?? "?"
    const reason = typeof args.reason === "string" ? args.reason : ""
    return reason ? `⏰ wake in ${delay}s — ${reason}` : `⏰ wake in ${delay}s`
  },
  task: subagentSummary,
  agent: subagentSummary,
  todowrite: (args) => {
    const todos = Array.isArray(args.todos) ? args.todos : []
    return `☑ todos (${todos.length})`
  },
  exitplanmode: () => "📋 plan ready",
}

/** A one-line human summary of a tool call, e.g. `read src/foo.ts` or `⏰ wake in 30s — checking CI`. */
export function formatToolCall(toolName: string, args: unknown): string {
  const name = toolName || "tool"
  const argsRecord = isRecord(args) ? args : {}

  const bespoke = BESPOKE_TOOLS[name.toLowerCase()]
  if (bespoke) return bespoke(argsRecord)

  const salient = pickSalientArg(argsRecord)
  if (salient !== null) {
    // Some ACP agents (e.g. claude-agent-acp) already bake the salient
    // value into a curated title — "Read src/foo.ts" alongside
    // arguments.path === "src/foo.ts". Appending it again would render
    // "Read src/foo.ts src/foo.ts". Only append when it adds new info.
    if (name.toLowerCase().includes(salient.toLowerCase())) {
      return truncate(name, MAX_CALL_LENGTH)
    }
    return truncate(`${name} ${salient}`, MAX_CALL_LENGTH)
  }

  if (Object.keys(argsRecord).length === 0) return name

  return truncate(`${name} ${JSON.stringify(args)}`, MAX_CALL_LENGTH)
}

function extractText(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    const parts = value.map(extractText).filter((v): v is string => v != null)
    return parts.length ? parts.join("\n") : null
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text
    if (typeof value.message === "string") return value.message
    if (Array.isArray(value.content)) return extractText(value.content)
    if (typeof value.error === "string") return value.error
    if (isRecord(value.error) && typeof value.error.message === "string") {
      return value.error.message
    }
    return null
  }
  return null
}

/**
 * A short outcome line for a completed tool call, or `null` when there's
 * nothing useful to show (e.g. an empty/void result). `toolName` is
 * accepted for parity with `formatToolCall` and future bespoke result
 * formatting, but generic text extraction covers today's cases.
 */
export function formatToolResult(
  toolName: string | undefined,
  result: unknown,
  isError: boolean,
): string | null {
  void toolName
  const text = extractText(result)

  if (isError) {
    const message = text ?? (result != null ? JSON.stringify(result) : "failed")
    const firstLine = message.split(/\r?\n/)[0] ?? message
    return truncate(firstLine, MAX_RESULT_LENGTH)
  }

  if (text == null) return null
  const trimmed = text.trim()
  if (!trimmed) return null

  const lines = trimmed.split(/\r?\n/)
  if (lines.length > 1) {
    const bytes = Buffer.byteLength(trimmed, "utf8")
    return `${lines.length} lines, ${bytes}B`
  }
  return truncate(lines[0]!, MAX_RESULT_LENGTH)
}

/** The stdout sentinel the CI artifact-ledger delivery helper prints when it
 *  creates a PR / review / comment — MUST byte-match `ARTIFACT_MARKER` in
 *  `scripts/lib/artifact-ledger.mjs` (the runner-side harvester). */
export const ARTIFACT_MARKER = "::agentproto-artifact::"

/** Ring lines per tool result the marker passthrough will re-emit at most —
 *  a delivery tool call creates one artifact, so >1 is already unusual; the
 *  cap only bounds a pathological result that echoes markers in a loop. */
const MAX_ARTIFACT_MARKER_LINES = 8

/**
 * The `::agentproto-artifact::` marker lines buried in a tool result, if any.
 *
 * The one-line summary {@link formatToolResult} produces is deliberately
 * lossy ("N lines, XB") — correct for humans, fatal for the CI artifact
 * ledger: the agentflow delivery helper (`deliver-artifact.mjs`) prints its
 * marker to a tool's stdout precisely so the `agentproto-run` driver can
 * harvest created PR/review/comment ids back out of `agent_output`. This
 * extracts those lines so the ring can carry them verbatim alongside the
 * summary. Returned WITHOUT ANSI styling on purpose: the harvester
 * (`parseArtifactMarkers`) does `indexOf(marker)` then `JSON.parse` of the
 * line's remainder, so a trailing reset code would corrupt the JSON.
 */
export function artifactMarkerLines(result: unknown): string[] {
  const text = extractText(result)
  if (text == null || !text.includes(ARTIFACT_MARKER)) return []
  return text
    .split(/\r?\n/)
    .filter(line => line.includes(ARTIFACT_MARKER))
    .slice(0, MAX_ARTIFACT_MARKER_LINES)
    .map(line => line.trim())
}

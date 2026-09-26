/**
 * Background-task lifecycle helpers for agent-cli sessions.
 *
 * An agent can start work that outlives its turn — Claude Code's
 * `run_in_background` Bash is the common case. Over ACP the agent reports
 * that work's lifecycle through the AIR `asyncTasks` extension (see
 * @agentproto/acp's `background-task` StreamEvent); the registry mirrors the
 * running set onto `SessionDescriptor.backgroundTasks` and, when a task
 * settles while the session is idle and the agent does not wake itself,
 * prompts it with the wake text built here. Pure helpers only — the
 * registry owns the state and the timers.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs"

/** How long the registry waits, after a background task settles on an idle
 *  session, for the agent to wake ITSELF before it sends the wake prompt.
 *  Claude Code starts its own task-notification cycle within a few seconds;
 *  the grace keeps the daemon from double-waking it. */
export const DEFAULT_BG_TASK_WAKE_GRACE_MS = 20_000

/** Max lines / bytes of a task's output file quoted into the wake prompt. */
const OUTPUT_TAIL_LINES = 20
const OUTPUT_TAIL_BYTES = 2_000

/** One background task as mirrored onto `SessionDescriptor.backgroundTasks`. */
export interface SessionBackgroundTask {
  taskId: string
  /** Friendly task type (`"shell"`, `"monitor"`, ...), when the agent says. */
  taskKind?: string
  description?: string
  /** Where the task writes its output, when the agent says. */
  outputFile?: string
  status: "running" | "paused" | "completed" | "failed" | "stopped"
  summary?: string
  toolCallId?: string
  /** ISO 8601 — when the daemon first heard of the task. */
  startedAt: string
}

/**
 * The last {@link OUTPUT_TAIL_LINES} lines (at most {@link OUTPUT_TAIL_BYTES})
 * of a task's output file, or undefined when it can't be read or is empty.
 * Reads only the tail, so a multi-megabyte log costs one small read.
 */
export function readOutputTail(path: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const size = fstatSync(fd).size
    if (size === 0) return undefined
    const length = Math.min(size, OUTPUT_TAIL_BYTES)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, size - length)
    const lines = buf.toString("utf8").replace(/\s+$/, "").split(/\r?\n/)
    // A tail cut mid-file starts with a partial line — drop it.
    if (size > length && lines.length > 1) lines.shift()
    const tail = lines.slice(-OUTPUT_TAIL_LINES).join("\n")
    return tail.length > 0 ? tail : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * The follow-up prompt that wakes a session whose background task(s)
 * settled — the same news Claude Code delivers natively as a
 * task-notification: one `[background task <id> <status>] <description>.
 * Output: <file>` block per task, plus a short tail of its output.
 */
export function buildBackgroundTaskWakePrompt(
  tasks: readonly SessionBackgroundTask[],
  readTail: (path: string) => string | undefined = readOutputTail,
): string {
  const blocks = tasks.map(task => {
    const what = task.description ?? task.summary ?? "background task"
    const lines = [
      `[background task ${task.taskId} ${task.status}] ${what}.` +
        (task.outputFile ? ` Output: ${task.outputFile}` : ""),
    ]
    if (task.summary && task.summary !== what) lines.push(task.summary)
    const tail = task.outputFile ? readTail(task.outputFile) : undefined
    if (tail) lines.push("Last lines of output:", "```", tail, "```")
    return lines.join("\n")
  })
  return blocks.join("\n\n")
}

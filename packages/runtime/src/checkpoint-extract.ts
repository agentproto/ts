/**
 * Deterministic content extraction for context checkpoints.
 *
 * Everything here turns facts the daemon already holds — the transcript, the
 * completion-policy supervisor's last gate result, the task ledger, the
 * session descriptor — into checkpoint section text. A section with nothing
 * to say is left out (the helpers return `undefined`); a placeholder string
 * is never produced.
 *
 * The optional "handoff turn" (ask the live source session to summarise
 * itself as JSON) lives here too: the prompt, the zod-validated reply shape,
 * the tolerant JSON extraction, and the registry-backed asker.
 */

import { z } from "zod"
import { readLastAssistantTextSync } from "./session-outcome.js"
import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"
import type { CompletionPolicySupervisor } from "./supervisor.js"
import { policyWatchesSession } from "./supervisor.js"
import type { TaskLedger, TaskRecord } from "./task-ledger.js"
import { HANDOFF_PROMPT_OPENER, HANDOFF_PROMPT_SOURCE } from "./handoff-markers.js"
import type { ExportedMessage } from "./transcript-export.js"
import { sessionEventsPath } from "./transcript-writer.js"

// ── Sources the daemon already holds ──────────────────────────────────

/** The most recent completion-policy gate result for a session. */
export interface CheckpointGateResult {
  policyId: string
  kind: "shell" | "judge"
  /** The gate command line (shell gates only; absent on older persisted state). */
  command?: string
  exitCode: number
  at: string
  stdout?: string
  stderr?: string
  /** Judge gates: the parsed verdict decision / reason when present. */
  verdict?: string
}

/** A not-yet-closed task-ledger entry tied to a session. */
export interface CheckpointOpenTask {
  taskId: string
  title: string
  status: string
  description?: string
}

/**
 * Daemon-side lookups a checkpoint draws on. Both are optional: without
 * them the checkpoint falls back to the transcript alone.
 */
export interface CheckpointSources {
  lastGate?: (sessionId: string) => CheckpointGateResult | undefined
  openTasks?: (sessionId: string) => CheckpointOpenTask[]
}

const OPEN_TASK_STATUSES = new Set(["in_progress", "awaiting_approval", "pending"])
const OPEN_TASK_RANK: Record<string, number> = { in_progress: 0, awaiting_approval: 1, pending: 2 }

function taskTouchesSession(task: TaskRecord, sessionId: string): boolean {
  return task.owner === sessionId || (task.sessions?.includes(sessionId) ?? false)
}

/**
 * Build {@link CheckpointSources} from the supervisor and task ledger the
 * daemon already runs. Either dependency may be omitted.
 */
export function createCheckpointSources(deps: {
  supervisor?: Pick<CompletionPolicySupervisor, "list">
  taskLedger?: Pick<TaskLedger, "snapshot">
}): CheckpointSources {
  const { supervisor, taskLedger } = deps
  return {
    ...(supervisor
      ? {
          lastGate: (sessionId: string): CheckpointGateResult | undefined => {
            let best: CheckpointGateResult | undefined
            for (const policy of supervisor.list()) {
              if (!policyWatchesSession(policy, sessionId)) continue
              const gate = policy.lastGate
              if (!gate || (gate.kind !== "shell" && gate.kind !== "judge")) continue
              if (best && gate.at <= best.at) continue
              best = {
                policyId: policy.policyId,
                kind: gate.kind,
                ...(gate.command ? { command: gate.command } : {}),
                exitCode: gate.exitCode,
                at: gate.at,
                ...(gate.stdout ? { stdout: gate.stdout } : {}),
                ...(gate.stderr ? { stderr: gate.stderr } : {}),
                ...(policy.verdict?.decision ? { verdict: String(policy.verdict.decision) } : {}),
              }
            }
            return best
          },
        }
      : {}),
    ...(taskLedger
      ? {
          openTasks: (sessionId: string): CheckpointOpenTask[] =>
            taskLedger
              .snapshot()
              .filter(t => OPEN_TASK_STATUSES.has(t.status) && taskTouchesSession(t, sessionId))
              .sort((a, b) => (OPEN_TASK_RANK[a.status] ?? 9) - (OPEN_TASK_RANK[b.status] ?? 9))
              .map(t => ({
                taskId: t.taskId,
                title: t.title,
                status: t.status,
                ...(t.description ? { description: t.description } : {}),
              })),
        }
      : {}),
  }
}

// ── Transcript extraction ─────────────────────────────────────────────

const GOAL_CHAR_CAP = 1000
const TEST_OUTPUT_TAIL = 600
const AGENT_MESSAGE_TAIL = 800

function clip(text: string, max: number, side: "head" | "tail"): string {
  if (text.length <= max) return text
  return side === "head" ? `${text.slice(0, max)}…` : `…${text.slice(-max)}`
}

/**
 * The session's initial prompt: the first human/daemon user message of the
 * transcript. A session that was itself a continuation starts with a
 * checkpoint prompt — recover the original goal from its `## goal` section
 * rather than quoting the whole handoff frame.
 */
export function extractGoal(messages: ExportedMessage[]): string | undefined {
  const first = messages.find(m => m.role === "user" && !m.from && m.text?.trim())
  const text = first?.text?.trim()
  if (!text) return undefined
  if (text.startsWith("[continued session")) {
    const m = /(?:^|\n)## goal\n([\s\S]*?)(?=\n## |\n*$)/.exec(text)
    const carried = m?.[1]?.trim()
    return carried ? clip(carried, GOAL_CHAR_CAP, "head") : undefined
  }
  return clip(text, GOAL_CHAR_CAP, "head")
}

/** Latest `[plan] n/m …` system notice, rendered as a plan line. */
export function extractPlan(messages: ExportedMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "system" || !m.text?.startsWith("[plan]")) continue
    const parsed = /^\[plan\]\s*(\d+)\/(\d+)\s*([\s\S]*)$/.exec(m.text)
    if (!parsed) return m.text.replace(/^\[plan\]\s*/, "").trim() || undefined
    const [, done, total, list] = parsed
    return `Plan (${done}/${total} steps done): ${list?.trim() ?? ""}`.trim()
  }
  return undefined
}

/** Latest `[error]` system notice in the transcript. */
export function extractLastError(messages: ExportedMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "system" || !m.text?.startsWith("[error]")) continue
    const text = m.text.replace(/^\[error\]\s*/, "").trim()
    if (text) return text
  }
  return undefined
}

/** Last assistant message that carries prose (not just tool calls). */
export function extractLastAgentMessage(messages: ExportedMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === "assistant" && m.text?.trim()) return clip(m.text.trim(), AGENT_MESSAGE_TAIL, "tail")
  }
  return undefined
}

const TEST_COMMAND_RE =
  /\b(vitest|jest|pytest|mocha|phpunit|rspec|cargo\s+test|go\s+test|tsc\s+--noEmit|playwright\s+test|(?:pnpm|npm|yarn|bun)\b[^\n|&;]*?\b(?:test|check-types|typecheck))\b/i

function commandFromToolArgs(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args)
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>
      for (const key of ["command", "cmd", "script"]) {
        if (typeof o[key] === "string") return o[key] as string
      }
    }
  } catch {
    // not JSON — fall through to the raw args
  }
  return args
}

export interface ExtractedTestRun {
  command: string
  failed: boolean
  output: string
}

/** The last visible tool call that looks like a test/typecheck run, with its result. */
export function extractLastTestRun(messages: ExportedMessage[]): ExtractedTestRun | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "assistant" || !m.toolCalls?.length) continue
    for (let c = m.toolCalls.length - 1; c >= 0; c--) {
      const call = m.toolCalls[c]
      if (!call) continue
      const command = commandFromToolArgs(call.args)
      if (!TEST_COMMAND_RE.test(command)) continue
      const result = messages.slice(i + 1).find(n => n.role === "tool" && (!n.toolName || n.toolName === call.name))
      const text = result?.text ?? ""
      return {
        command: clip(command.trim(), 200, "head"),
        failed: text.startsWith("[error]"),
        output: clip(text.replace(/^\[error\]\s*/, "").trim(), TEST_OUTPUT_TAIL, "tail"),
      }
    }
  }
  return undefined
}

export function formatGateResult(gate: CheckpointGateResult): string {
  const passed = gate.exitCode === 0
  const what = gate.kind === "judge" ? "judge gate" : gate.command ? `\`${gate.command}\`` : "shell gate"
  const verdict = gate.verdict ? ` (verdict: ${gate.verdict})` : ""
  const lines = [
    `Last policy gate (${gate.policyId}, ${gate.kind}): ${what} — ${passed ? "PASSED" : `FAILED (exit ${gate.exitCode})`}${verdict} at ${gate.at}`,
  ]
  const output = [gate.stdout, gate.stderr].filter(Boolean).join("\n").trim()
  if (output) lines.push(clip(output, TEST_OUTPUT_TAIL, "tail"))
  return lines.join("\n")
}

export function formatTestRun(run: ExtractedTestRun): string {
  const lines = [`Last test-like tool call: \`${run.command}\` — ${run.failed ? "tool reported an error" : "completed without a tool error"}`]
  if (run.output) lines.push(run.output)
  return lines.join("\n")
}

export function formatOpenTasks(tasks: CheckpointOpenTask[]): string {
  return ["Open tasks:", ...tasks.map(t => `- [${t.status}] ${t.title} (${t.taskId})`)].join("\n")
}

/** Last message-style line of the session as a next-step hint. */
export function formatLastAgentMessage(text: string): string {
  return `Last agent message (no open tasks recorded):\n${text}`
}

// ── Handoff turn ──────────────────────────────────────────────────────

/** Default time the source session gets to answer the handoff turn. */
export const DEFAULT_HANDOFF_TIMEOUT_MS = 60_000

const nonEmpty = z.string().trim().min(1)

/** Reply shape requested from the source session. */
export const handoffReplySchema = z
  .object({
    goal: nonEmpty.optional(),
    decisions: z.array(nonEmpty).default([]),
    tests: z.object({ command: z.string().default(""), result: z.string().default("") }).optional(),
    openRisks: z.array(nonEmpty).default([]),
    nextStep: nonEmpty.optional(),
  })
  .refine(r => r.goal || r.decisions.length || r.tests || r.openRisks.length || r.nextStep, {
    message: "handoff reply is empty",
  })

export type HandoffReply = z.infer<typeof handoffReplySchema>

export const HANDOFF_PROMPT = [
  HANDOFF_PROMPT_OPENER,
  "This session is about to be continued by a fresh session (possibly on a different harness).",
  "Do NOT use any tools and do NOT continue the task. Reply with ONLY one JSON object, no prose, in exactly this shape:",
  "{",
  '  "goal": "what this session is trying to achieve, in one or two sentences",',
  '  "decisions": ["each decision made so far and why, one string per decision"],',
  '  "tests": { "command": "the last test/check command you ran", "result": "pass/fail and the key lines of output" },',
  '  "openRisks": ["anything unfinished, fragile or unverified"],',
  '  "nextStep": "the single most useful next action"',
  "}",
  'Use "" / [] for anything that does not apply. Be specific and brief.',
].join("\n")

function* jsonCandidates(text: string): Generator<string> {
  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (fence[1]) yield fence[1].trim()
  }
  // Balanced-brace scan from each `{` — tolerates prose around the object.
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (ch === "\\") i++
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === "{") depth++
      else if (ch === "}" && --depth === 0) {
        yield text.slice(start, i + 1)
        break
      }
    }
  }
}

/** Parse + validate the source session's reply; `undefined` when unusable. */
export function parseHandoffReply(text: string): HandoffReply | undefined {
  for (const candidate of jsonCandidates(text)) {
    let raw: unknown
    try {
      raw = JSON.parse(candidate)
    } catch {
      continue
    }
    const parsed = handoffReplySchema.safeParse(raw)
    if (parsed.success) return parsed.data
  }
  return undefined
}

/** Sends the handoff prompt to the source session and resolves with its reply text. */
export type HandoffAsker = (prompt: string, opts: { timeoutMs: number }) => Promise<string>

/** What the registry-backed asker needs from {@link SessionsRegistry}. */
export type HandoffRegistry = Pick<SessionsRegistry, "get" | "sendPrompt"> &
  Partial<Pick<SessionsRegistry, "interruptSession">>

export { HANDOFF_PROMPT_SOURCE }

/** The source session cannot take a handoff turn right now (dead / busy) — not a failure. */
export class HandoffUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HandoffUnavailableError"
  }
}

const REPLY_POLL_MS = 50
const REPLY_POLL_ATTEMPTS = 20

/**
 * Asker that drives a live, idle session through `registry.sendPrompt` and
 * reads the answer back from its transcript. Rejects (so the caller falls
 * back to extraction) when the session is dead, busy, waiting on input,
 * out of time, or answers nothing new.
 */
export function createRegistryHandoffAsker(
  registry: HandoffRegistry,
  desc: SessionDescriptor,
  baseDir?: string,
): HandoffAsker | undefined {
  if (typeof registry.sendPrompt !== "function") return undefined
  const sessionId = desc.id
  return async (prompt, { timeoutMs }) => {
    const live = registry.get(sessionId)
    if (!live || live.status !== "running") throw new HandoffUnavailableError("source session is not running")
    if (live.busy || live.awaitingInput || live.awaitingPermission) {
      throw new HandoffUnavailableError("source session is busy")
    }
    const eventsPath = sessionEventsPath(sessionId, baseDir)
    const before = readLastAssistantTextSync(eventsPath)

    const turn = registry.sendPrompt(sessionId, prompt, { source: HANDOFF_PROMPT_SOURCE })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = Symbol("timeout")
    const deadline = new Promise<typeof timedOut>(resolve => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs)
    })
    try {
      const outcome = await Promise.race([turn, deadline])
      if (outcome === timedOut) {
        void turn.catch(() => undefined)
        void registry.interruptSession?.(sessionId).catch(() => undefined)
        throw new Error(`source session did not answer within ${timeoutMs}ms`)
      }
    } finally {
      if (timer) clearTimeout(timer)
    }

    // The transcript append is asynchronous relative to the turn settling.
    for (let attempt = 0; attempt < REPLY_POLL_ATTEMPTS; attempt++) {
      const reply = readLastAssistantTextSync(eventsPath)
      if (reply && reply !== before) return reply
      await new Promise(resolve => setTimeout(resolve, REPLY_POLL_MS))
    }
    throw new Error("source session produced no reply")
  }
}

// ── Section formatting for handoff replies ────────────────────────────

export function formatBullets(items: string[]): string {
  return items.map(i => `- ${i}`).join("\n")
}

export function formatHandoffTests(tests: NonNullable<HandoffReply["tests"]>): string | undefined {
  const command = tests.command.trim()
  const result = tests.result.trim()
  if (!command && !result) return undefined
  return `Reported by the source agent: ${command ? `\`${command}\`` : "(command not given)"}${result ? ` — ${result}` : ""}`
}

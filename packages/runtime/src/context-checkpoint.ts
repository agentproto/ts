/**
 * Structured checkpoint builder and persistence for context continuity.
 *
 * A checkpoint is a bounded, durable handoff document summarising the state
 * of a session that is approaching its context limit. It is persisted next
 * to the session's `events.jsonl` and referenced (never a replacement) from
 * the fresh continuation session. The original transcript remains untouched.
 */

import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  CHECKPOINT_SCHEMA_VERSION,
} from "./checkpoint-schema.js"
import {
  DEFAULT_HANDOFF_TIMEOUT_MS,
  HANDOFF_PROMPT,
  createRegistryHandoffAsker,
  extractGoal,
  extractLastAgentMessage,
  extractLastError,
  extractLastTestRun,
  extractPlan,
  formatBullets,
  formatGateResult,
  formatHandoffTests,
  formatLastAgentMessage,
  formatOpenTasks,
  formatTestRun,
  parseHandoffReply,
  type CheckpointSources,
  HandoffUnavailableError,
  type HandoffAsker,
  type HandoffRegistry,
  type HandoffReply,
} from "./checkpoint-extract.js"
import type { SessionDescriptor } from "./sessions.js"
import { exportDaemonEventsSession, renderMarkdown, type ExportedMessage } from "./transcript-export.js"
import { sessionEventsPath, sessionTranscriptDir } from "./transcript-writer.js"
import {
  contextContinuityStateForPct,
  type ContextContinuityCheckpointSections,
  type ContextContinuityPolicy,
  type ResolvedContextContinuityPolicy,
} from "./context-continuity.js"

/** A persisted structured checkpoint. */
export interface ContextCheckpoint {
  /** Contract version of this document — see `schemas/checkpoint.v1.json`. */
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION
  /** Stable checkpoint identifier. */
  checkpointId: string
  /** Session that produced the checkpoint. */
  sourceSessionId: string
  /** ISO 8601 creation timestamp. */
  createdAt: string
  /** Context percentage that triggered the checkpoint. */
  contextPct: number
  /** Effective policy snapshot. */
  policy: ResolvedContextContinuityPolicy
  /** Sections requested and present. A section with nothing real to say is
   *  omitted — never a placeholder. */
  sections: ContextCheckpointSections
  /** How the optional handoff turn (asking the live source session to
   *  summarise itself) went. Absent on checkpoints written before it existed. */
  handoffTurn?: CheckpointHandoffTurn
  /** Bounded digest of the most recent turns. */
  recentDigest: string
  /** Absolute path to the original events.jsonl transcript. */
  originalTranscriptPath: string
  /** Absolute path where this checkpoint JSON was persisted. */
  checkpointPath: string
  /** Suggested next action at the time the checkpoint was taken:
   *  `compact_then_continue` only inside the compact band
   *  (`compactAtPct` up to `continueFreshAtPct`), `continue` everywhere else. */
  nextAction: "continue" | "compact_then_continue" | "ask"
}

export interface CheckpointHandoffTurn {
  /** `answered`: valid summary received; `skipped`: not requested or no live
   *  idle session; `failed`: asked, but timed out or the reply was unusable. */
  status: "answered" | "skipped" | "failed"
  reason?: string
}

export interface ContextCheckpointSections {
  goal?: string
  plan?: string
  decisions?: string
  changedFiles?: string
  gitStatus?: string
  tests?: string
  errors?: string
  risks?: string
  nextStep?: string
  config?: string
  /** Free-text notes the operator attached to the handoff, verbatim. */
  notes?: string
}

export interface BuildContextCheckpointOptions {
  /** Context percentage that triggered the checkpoint. */
  contextPct: number
  /** Override which sections to build; defaults to the resolved policy. */
  sections?: ContextContinuityCheckpointSections
  /** Base directory for session storage (defaults to ~/.agentproto/sessions). */
  baseDir?: string
  /** Operator notes (e.g. decisions to carry over), stored verbatim in `sections.notes`. */
  notes?: string
  /**
   * Ask the live source session to summarise itself (goal, decisions, tests,
   * risks, next step) before the checkpoint is built. Defaults to `true`, but
   * only takes effect when `registry` (or `handoffAsker`) is supplied and the
   * session is running and idle; any failure or timeout falls back to the
   * deterministic extraction. Pass `false` for read-only flows (dry runs) and
   * when the session is already at its context limit.
   */
  askSource?: boolean
  /** Time the source session gets to answer. Default {@link DEFAULT_HANDOFF_TIMEOUT_MS}. */
  askTimeoutMs?: number
  /** Registry used to prompt the source session for the handoff turn. */
  registry?: HandoffRegistry
  /** Custom asker, overriding the registry-backed one (tests, remote sessions). */
  handoffAsker?: HandoffAsker
  /** Supervisor gate results / task ledger lookups (see `createCheckpointSources`). */
  sources?: CheckpointSources
}

/** Shown with every handoff dry run: the preview skips the question put to the source session. */
export const HANDOFF_DRY_RUN_NOTE =
  "Approximate content: a dry run never prompts the source session, so this preview is extracted from " +
  "the transcript alone (goal, decisions, tests and next step may be thinner than the real handoff). " +
  "The real handoff asks the source session to summarise itself first."

/** Character budget for the rendered recent-turn digest. */
const DIGEST_CHAR_BUDGET = 7000
/** Character cap for each individual section. */
const SECTION_CHAR_CAP = 1200
/** Character cap for tool-result bodies inside the digest. */
const TOOL_CHAR_CAP = 200

function truncText(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n… [${text.length - cap} chars truncated]`
}

function approxMessageLen(m: ExportedMessage): number {
  const toolLen =
    m.toolCalls?.reduce(
      (sum, tc) => sum + tc.name.length + Math.min(tc.args.length, TOOL_CHAR_CAP),
      0,
    ) ?? 0
  return (m.text?.length ?? 0) + (m.reasoning?.length ?? 0) + toolLen + 32
}

interface TranscriptView {
  messages: ExportedMessage[]
  digest: string
}

async function readTranscript(sessionId: string): Promise<TranscriptView> {
  let messages: ExportedMessage[]
  try {
    // The handoff exchange and the daemon-composed preamble are plumbing,
    // not work: leave them out of the digest, the extraction and the
    // resume prompt.
    messages = (await exportDaemonEventsSession(sessionId)).messages.filter(m => !m.internal)
  } catch {
    return { messages: [], digest: "(no daemon transcript available)" }
  }
  return { messages, digest: buildRecentDigest(messages) }
}

function buildRecentDigest(messages: ExportedMessage[]): string {
  if (messages.length === 0) return "(no turns yet)"

  let total = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    const next = total + approxMessageLen(m)
    if (next > DIGEST_CHAR_BUDGET && start < messages.length) break
    total = next
    start = i
  }

  const rendered = renderMarkdown(
    { meta: {}, messages: messages.slice(start) },
    { maxToolChars: TOOL_CHAR_CAP },
  )
  const body =
    rendered.length > DIGEST_CHAR_BUDGET
      ? `${rendered.slice(0, DIGEST_CHAR_BUDGET)}\n… [${rendered.length - DIGEST_CHAR_BUDGET} chars truncated]`
      : rendered

  return body
}

async function captureGitStatus(cwd: string | undefined): Promise<string | undefined> {
  if (!cwd) return undefined
  return new Promise(resolve => {
    execFile("git", ["status", "--porcelain"], { cwd }, (err, stdout) => {
      if (err) {
        resolve(undefined)
        return
      }
      const trimmed = stdout.trim()
      resolve(trimmed || "(working tree clean)")
    })
  })
}

function formatConfigSection(desc: SessionDescriptor): string {
  const parts: string[] = []
  if (desc.model) parts.push(`model: ${desc.model}`)
  if (desc.effort) parts.push(`effort: ${desc.effort}`)
  if (desc.harness ?? desc.adapterSlug) parts.push(`harness: ${desc.harness ?? desc.adapterSlug}`)
  if (desc.route?.gateway) parts.push(`gateway: ${desc.route.gateway}`)
  if (desc.accessProfile?.profileRef) parts.push(`access: ${desc.accessProfile.profileRef}`)
  if (desc.posture) {
    const posture = typeof desc.posture === "string" ? desc.posture : desc.posture.harnessModeId
    parts.push(`posture: ${posture}`)
  }
  if (desc.contextProfile) parts.push(`contextProfile: ${desc.contextProfile}`)
  if (desc.cwd) parts.push(`cwd: ${desc.cwd}`)
  return parts.join("\n") || "(config not recorded)"
}

function effectiveSections(
  policy: ResolvedContextContinuityPolicy,
  override?: ContextContinuityCheckpointSections,
): Required<ContextContinuityCheckpointSections> {
  return {
    goal: override?.goal ?? policy.goal,
    plan: override?.plan ?? policy.plan,
    decisions: override?.decisions ?? policy.decisions,
    changedFiles: override?.changedFiles ?? policy.changedFiles,
    gitStatus: override?.gitStatus ?? policy.gitStatus,
    tests: override?.tests ?? policy.tests,
    errors: override?.errors ?? policy.errors,
    risks: override?.risks ?? policy.risks,
    nextStep: override?.nextStep ?? policy.nextStep,
    config: override?.config ?? policy.config,
  }
}

/** Character cap for operator notes — they are deliberate, so given more room. */
const NOTES_CHAR_CAP = 4000

interface HandoffTurnOutcome {
  reply?: HandoffReply
  turn: CheckpointHandoffTurn
}

async function runHandoffTurn(
  desc: SessionDescriptor,
  opts: BuildContextCheckpointOptions,
): Promise<HandoffTurnOutcome> {
  if (opts.askSource === false) {
    return { turn: { status: "skipped", reason: "askSource disabled" } }
  }
  const asker =
    opts.handoffAsker ??
    (opts.registry ? createRegistryHandoffAsker(opts.registry, desc, opts.baseDir) : undefined)
  if (!asker) {
    return { turn: { status: "skipped", reason: "no registry available to prompt the source session" } }
  }
  let text: string
  try {
    text = await asker(HANDOFF_PROMPT, { timeoutMs: opts.askTimeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      turn: {
        status: err instanceof HandoffUnavailableError ? "skipped" : "failed",
        reason,
      },
    }
  }
  const reply = parseHandoffReply(text)
  if (!reply) {
    return { turn: { status: "failed", reason: "source session reply was not a valid handoff JSON object" } }
  }
  return { reply, turn: { status: "answered" } }
}

function buildGoalSection(
  messages: ExportedMessage[],
  desc: SessionDescriptor,
  reply: HandoffReply | undefined,
): string | undefined {
  const initial = extractGoal(messages) ?? desc.title?.trim() ?? undefined
  const current = reply?.goal
  if (initial && current && current !== initial) {
    return `${initial}\n\nCurrent goal (per the source session): ${current}`
  }
  return initial ?? current
}

function buildTestsSection(
  messages: ExportedMessage[],
  desc: SessionDescriptor,
  reply: HandoffReply | undefined,
  sources: CheckpointSources | undefined,
): string {
  const parts: string[] = []
  const gate = sources?.lastGate?.(desc.id)
  if (gate) parts.push(formatGateResult(gate))
  else {
    const run = extractLastTestRun(messages)
    if (run) parts.push(formatTestRun(run))
  }
  const reported = reply?.tests ? formatHandoffTests(reply.tests) : undefined
  if (reported) parts.push(reported)
  return parts.join("\n\n") || "no test run recorded"
}

function buildNextStepSection(
  messages: ExportedMessage[],
  desc: SessionDescriptor,
  reply: HandoffReply | undefined,
  sources: CheckpointSources | undefined,
): string | undefined {
  const tasks = sources?.openTasks?.(desc.id) ?? []
  const tasksText = tasks.length > 0 ? formatOpenTasks(tasks) : undefined
  if (reply?.nextStep) return [reply.nextStep, tasksText].filter(Boolean).join("\n\n")
  if (tasksText) return tasksText
  const last = extractLastAgentMessage(messages)
  return last ? formatLastAgentMessage(last) : undefined
}

function suggestNextAction(
  pct: number,
  policy: ResolvedContextContinuityPolicy,
): ContextCheckpoint["nextAction"] {
  return contextContinuityStateForPct(pct, policy) === "compact" ? "compact_then_continue" : "continue"
}

/**
 * Build a bounded structured checkpoint for `desc`.
 *
 * Reads the daemon's own `events.jsonl` transcript so the original history
 * is never discarded; the checkpoint carries a bounded digest plus sections
 * filled from, in order of preference: the source session's own answer to a
 * handoff turn, the daemon's records (last policy gate, open tasks) and the
 * transcript. A section with nothing real to say is omitted.
 */
export async function buildContextCheckpoint(
  desc: SessionDescriptor,
  opts: BuildContextCheckpointOptions,
): Promise<ContextCheckpoint> {
  const policy = desc.contextContinuity
  if (!policy) throw new Error(`Session ${desc.id} has no resolved context continuity policy`)

  const sectionsReq = effectiveSections(policy, opts.sections)
  const now = new Date().toISOString()
  const checkpointId = `ckpt_${desc.id}_${Date.now()}`
  const checkpointPath = checkpointFilePath(desc.id, checkpointId, opts.baseDir)

  const gitStatus = sectionsReq.gitStatus ? await captureGitStatus(desc.cwd) : undefined
  // Read BEFORE the handoff turn so the digest and extraction describe the
  // work itself, not the handoff exchange.
  const { messages, digest: recentDigest } = await readTranscript(desc.id)
  const { reply, turn: handoffTurn } = await runHandoffTurn(desc, opts)

  const sections: ContextCheckpointSections = {}
  const put = (key: keyof ContextCheckpointSections, value: string | undefined, cap = SECTION_CHAR_CAP): void => {
    const trimmed = value?.trim()
    if (trimmed) sections[key] = truncText(trimmed, cap)
  }
  if (sectionsReq.goal) put("goal", buildGoalSection(messages, desc, reply))
  if (sectionsReq.plan) put("plan", extractPlan(messages))
  if (sectionsReq.decisions && reply?.decisions.length) put("decisions", formatBullets(reply.decisions))
  if (sectionsReq.changedFiles) {
    put(
      "changedFiles",
      gitStatus && gitStatus !== "(working tree clean)"
        ? `Changed files:\n${gitStatus}`
        : "(no changed files captured)",
    )
  }
  if (sectionsReq.gitStatus) put("gitStatus", gitStatus ?? "(not a git repository)")
  if (sectionsReq.tests) put("tests", buildTestsSection(messages, desc, reply, opts.sources))
  if (sectionsReq.errors) {
    put("errors", extractLastError(messages) ?? desc.lastTurnErrorMessage ?? desc.lastError)
  }
  if (sectionsReq.risks && reply?.openRisks.length) put("risks", formatBullets(reply.openRisks))
  if (sectionsReq.nextStep) put("nextStep", buildNextStepSection(messages, desc, reply, opts.sources))
  if (sectionsReq.config) put("config", formatConfigSection(desc))
  put("notes", opts.notes, NOTES_CHAR_CAP)

  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    checkpointId,
    sourceSessionId: desc.id,
    createdAt: now,
    contextPct: opts.contextPct,
    policy,
    sections,
    handoffTurn,
    recentDigest,
    originalTranscriptPath: sessionEventsPath(desc.id, opts.baseDir),
    checkpointPath,
    nextAction: suggestNextAction(opts.contextPct, policy),
  }
}

export function checkpointFilePath(
  sessionId: string,
  checkpointId: string,
  baseDir?: string,
): string {
  const dir = sessionTranscriptDir(sessionId, baseDir)
  return `${dir}/checkpoints/${checkpointId}.json`
}

/**
 * Persist `checkpoint` to disk and return the absolute path.
 */
export async function persistCheckpoint(checkpoint: ContextCheckpoint): Promise<ContextCheckpoint> {
  await mkdir(dirname(checkpoint.checkpointPath), { recursive: true })
  await writeFile(checkpoint.checkpointPath, JSON.stringify(checkpoint, null, 2), "utf8")
  return checkpoint
}

/** Render a checkpoint as the initial prompt for a fresh continuation. */
export function renderCheckpointPrompt(checkpoint: ContextCheckpoint): string {
  const lines: string[] = []
  lines.push("[continued session — this is a structured handoff from a prior session]")
  lines.push("")
  lines.push(
    `Source: ${checkpoint.sourceSessionId} · checkpoint ${checkpoint.checkpointId} · context was ${checkpoint.contextPct}% full.`,
  )
  lines.push(
    `Original transcript: ${checkpoint.originalTranscriptPath} (preserved; this prompt is a summary, not a replacement).`,
  )
  lines.push("")

  const sectionOrder: Array<keyof ContextCheckpointSections> = [
    "goal",
    "plan",
    "decisions",
    "changedFiles",
    "gitStatus",
    "tests",
    "errors",
    "risks",
    "nextStep",
    "notes",
    "config",
  ]
  for (const key of sectionOrder) {
    const value = checkpoint.sections[key]
    if (value) {
      lines.push(key === "notes" ? "## notes (from the operator)" : `## ${key}`)
      lines.push(value)
      lines.push("")
    }
  }

  lines.push("## Recent turns digest")
  lines.push(checkpoint.recentDigest)
  lines.push("")
  lines.push(
    checkpoint.sections.nextStep
      ? "Continue from the 'next step' above. Do not re-run completed work unless asked."
      : "Continue from where the recent turns left off. Do not re-run completed work unless asked.",
  )

  return lines.join("\n")
}

/** Resolve a checkpoint file path from an id previously persisted for a session. */
export function checkpointPathFromId(
  sessionId: string,
  checkpointId: string,
  baseDir?: string,
): string {
  return checkpointFilePath(sessionId, checkpointId, baseDir)
}

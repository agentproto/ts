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
import type { SessionDescriptor } from "./sessions.js"
import { exportDaemonEventsSession, renderMarkdown, type ExportedMessage } from "./transcript-export.js"
import { sessionEventsPath, sessionTranscriptDir } from "./transcript-writer.js"
import type {
  ContextContinuityCheckpointSections,
  ContextContinuityPolicy,
  ResolvedContextContinuityPolicy,
} from "./context-continuity.js"

/** A persisted structured checkpoint. */
export interface ContextCheckpoint {
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
  /** Sections requested and present. */
  sections: ContextCheckpointSections
  /** Bounded digest of the most recent turns. */
  recentDigest: string
  /** Absolute path to the original events.jsonl transcript. */
  originalTranscriptPath: string
  /** Absolute path where this checkpoint JSON was persisted. */
  checkpointPath: string
  /** Suggested next action at the time the checkpoint was taken. */
  nextAction: "continue" | "compact_then_continue" | "ask"
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
}

export interface BuildContextCheckpointOptions {
  /** Context percentage that triggered the checkpoint. */
  contextPct: number
  /** Override which sections to build; defaults to the resolved policy. */
  sections?: ContextContinuityCheckpointSections
  /** Base directory for session storage (defaults to ~/.agentproto/sessions). */
  baseDir?: string
}

/** Character budget for the rendered recent-turn digest. */
const DIGEST_CHAR_BUDGET = 7000
/** Character cap for each individual section. */
const SECTION_CHAR_CAP = 1200
/** Character cap for tool-result bodies inside the digest. */
const TOOL_CHAR_CAP = 200

function truncSection(text: string): string {
  if (text.length <= SECTION_CHAR_CAP) return text
  return `${text.slice(0, SECTION_CHAR_CAP)}\n… [${text.length - SECTION_CHAR_CAP} chars truncated]`
}

function approxMessageLen(m: ExportedMessage): number {
  const toolLen =
    m.toolCalls?.reduce(
      (sum, tc) => sum + tc.name.length + Math.min(tc.args.length, TOOL_CHAR_CAP),
      0,
    ) ?? 0
  return (m.text?.length ?? 0) + (m.reasoning?.length ?? 0) + toolLen + 32
}

async function buildRecentDigest(sessionId: string): Promise<string> {
  let messages: ExportedMessage[]
  try {
    messages = (await exportDaemonEventsSession(sessionId)).messages
  } catch {
    return "(no daemon transcript available)"
  }
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

/**
 * Build a bounded structured checkpoint for `desc`.
 *
 * Reads the daemon's own `events.jsonl` transcript so the original history
 * is never discarded; the checkpoint only carries a bounded digest plus
 * optional summary sections.
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
  const recentDigest = await buildRecentDigest(desc.id)

  const sections: ContextCheckpointSections = {}
  if (sectionsReq.goal) sections.goal = truncSection(desc.title ?? "(goal not recorded)")
  if (sectionsReq.plan) sections.plan = truncSection("(plan captured in recent digest)")
  if (sectionsReq.decisions) sections.decisions = truncSection("(decisions captured in recent digest)")
  if (sectionsReq.changedFiles) {
    sections.changedFiles = truncSection(
      gitStatus && gitStatus !== "(working tree clean)"
        ? `Changed files:\n${gitStatus}`
        : "(no changed files captured)",
    )
  }
  if (sectionsReq.gitStatus) sections.gitStatus = truncSection(gitStatus ?? "(not a git repository)")
  if (sectionsReq.tests) sections.tests = truncSection("(test results captured in recent digest)")
  if (sectionsReq.errors) sections.errors = truncSection("(errors captured in recent digest)")
  if (sectionsReq.risks) sections.risks = truncSection("(risks captured in recent digest)")
  if (sectionsReq.nextStep) sections.nextStep = truncSection("(next step captured in recent digest)")
  if (sectionsReq.config) sections.config = truncSection(formatConfigSection(desc))

  return {
    checkpointId,
    sourceSessionId: desc.id,
    createdAt: now,
    contextPct: opts.contextPct,
    policy,
    sections,
    recentDigest,
    originalTranscriptPath: sessionEventsPath(desc.id, opts.baseDir),
    checkpointPath,
    nextAction: opts.contextPct >= policy.continueFreshAtPct ? "continue" : "compact_then_continue",
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
    "config",
  ]
  for (const key of sectionOrder) {
    const value = checkpoint.sections[key]
    if (value) {
      lines.push(`## ${key}`)
      lines.push(value)
      lines.push("")
    }
  }

  lines.push("## Recent turns digest")
  lines.push(checkpoint.recentDigest)
  lines.push("")
  lines.push(
    "Continue from the 'next step' above. Do not re-run completed work unless asked.",
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

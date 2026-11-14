/**
 * Bounded evidence for the staged decision workflow (`collect-evidence`).
 *
 * Default export is METADATA ONLY: counts, categories, signals and range
 * refs derived from `git diff --numstat`. File paths leave this module only
 * when the DECISION.md evidence policy opts in (`allowPaths`); this collector
 * never reads hunks or file contents, so `allowCode` has nothing to release
 * here (a consumer that owns tier-2 evidence supplies it as `supplied`, and
 * it still goes through the same deny filter + secret scrub).
 *
 * Failures degrade to `complete: false` (which the policy's
 * `requireCompleteForClassifier` treats as uncertainty) — they never throw
 * into the workflow and never fabricate a clean range.
 */

import { execFile } from "node:child_process"
import { deniedEvidenceClass } from "./decision.js"
import type { DecisionPolicy } from "./decision-policy.js"

export type GitRunner = (cwd: string, args: readonly string[], timeoutMs: number) => Promise<string>

export const DEFAULT_EVIDENCE_MAX_FILES = 2_000
export const DEFAULT_EVIDENCE_TIMEOUT_MS = 20_000
const MAX_PATHS_EXPORTED = 200
const DEFAULT_BASE_REF = "origin/main"
const STRING_CAP = 200

export const defaultGit: GitRunner = (cwd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim().slice(0, 300)))
        else resolve(stdout)
      },
    )
  })

export interface CollectEvidenceOptions {
  readonly cwd: string
  readonly base?: string
  readonly head?: string
  readonly policy: DecisionPolicy
  /** Consumer-built evidence (e.g. a studio router's tier-1 state). Replaces
   *  the git-derived metadata; the range is still frozen from `cwd`. */
  readonly supplied?: Record<string, unknown>
  readonly maxFiles?: number
  readonly timeoutMs?: number
  readonly git?: GitRunner
}

export interface FrozenRange {
  readonly root: string
  readonly baseSha: string
  readonly headSha: string
}

export interface CollectedEvidence {
  readonly evidence: Record<string, unknown>
  readonly range?: FrozenRange
  readonly complete: boolean
  /** Export classes / keys withheld by policy or scrubbed (never the values). */
  readonly withheld: readonly string[]
  readonly notes: readonly string[]
}

const SECRET_RES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b[A-Za-z0-9+/_-]{48,}={0,2}(?![A-Za-z0-9])/g,
]

export function scrubSecrets(text: string): string {
  let out = text
  for (const re of SECRET_RES) out = out.replace(re, "[redacted]")
  return out
}

function scrubValue(value: unknown, withheld: Set<string>): unknown {
  if (typeof value === "string") {
    const capped = value.length > STRING_CAP ? `${value.slice(0, STRING_CAP)}…[truncated]` : value
    const scrubbed = scrubSecrets(capped)
    if (scrubbed !== capped) withheld.add("secrets")
    return scrubbed
  }
  if (Array.isArray(value)) return value.slice(0, 500).map(v => scrubValue(v, withheld))
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubValue(v, withheld)
    return out
  }
  return value
}

/** Drop every top-level key the policy withholds, scrub the rest. */
export function sanitizeEvidence(
  policy: DecisionPolicy,
  raw: Record<string, unknown>,
): { evidence: Record<string, unknown>; withheld: string[] } {
  const withheld = new Set<string>()
  const evidence: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const denied = deniedEvidenceClass(key, policy.evidence)
    if (denied) {
      withheld.add(denied)
      continue
    }
    evidence[key] = scrubValue(value, withheld)
  }
  return { evidence, withheld: [...withheld].sort() }
}

// ── path classification (paths never leave this function) ─────────────────

const DOC_RE = /(^|\/)(docs?|documentation)\/|\.(md|mdx|txt|rst)$|(^|\/)(README|CHANGELOG|LICENSE)[^/]*$/i
const LOCK_RE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock)$/
const TEST_RE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/i
const CONFIG_RE = /(^|\/)\.[^/]+rc(\.[a-z]+)?$|\.(json|ya?ml|toml|ini)$/i

const RISK_PATTERNS: ReadonlyArray<{ readonly category: string; readonly re: RegExp }> = [
  { category: "security", re: /(^|\/)(security|secrets?|crypto|credentials?|keychain|redaction)(\/|\.|-|$)|\.(pem|key|p12)$|\.env(\.|$)/i },
  { category: "auth", re: /(^|\/)(auth|oauth|authn|authz|login|sso)(\/|\.|-|$)|(^|\/)[^/]*auth[^/]*\.[cm]?[jt]sx?$/i },
  { category: "migration", re: /(^|\/)migrations?\/|\.sql$|(^|\/)schema\.prisma$/i },
  { category: "workflow", re: /(^|\/)\.github\/(workflows|actions)\/|(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$/ },
  { category: "dependencies", re: /(^|\/)package\.json$/ },
]

interface FileStat {
  readonly path: string
  readonly added: number
  readonly deleted: number
  readonly binary: boolean
}

function parseNumstatZ(out: string): FileStat[] {
  const files: FileStat[] = []
  for (const rec of out.split("\0")) {
    if (!rec) continue
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec)
    if (!m) continue
    const binary = m[1] === "-" || m[2] === "-"
    files.push({ path: m[3]!, added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary })
  }
  return files
}

function classify(files: readonly FileStat[]): {
  changeTypes: string
  riskCategories: string[]
  signals: string[]
  byKind: Record<string, number>
} {
  const byKind: Record<string, number> = { docs: 0, lock: 0, test: 0, config: 0, code: 0 }
  const risks = new Set<string>()
  for (const f of files) {
    const kind = DOC_RE.test(f.path)
      ? "docs"
      : LOCK_RE.test(f.path)
        ? "lock"
        : TEST_RE.test(f.path)
          ? "test"
          : CONFIG_RE.test(f.path)
            ? "config"
            : "code"
    byKind[kind] = (byKind[kind] ?? 0) + 1
    for (const { category, re } of RISK_PATTERNS) if (re.test(f.path)) risks.add(category)
  }
  const total = files.length
  const nonDocs = total - (byKind.docs ?? 0) - (byKind.lock ?? 0)
  const changeTypes =
    total === 0
      ? "empty"
      : nonDocs === 0
        ? "docs-only"
        : (byKind.test ?? 0) === total
          ? "tests-only"
          : (byKind.code ?? 0) === 0 && (byKind.test ?? 0) === 0
            ? "config"
            : (byKind.docs ?? 0) + (byKind.lock ?? 0) > 0
              ? "mixed"
              : "code"
  const riskCategories = [...risks].sort()
  const signals: string[] = []
  if (["security", "auth", "migration", "workflow"].some(c => risks.has(c))) signals.push("hardRisk")
  const lines = files.reduce((n, f) => n + f.added + f.deleted, 0)
  if (total > 50 || lines > 1_000) signals.push("large")
  if (files.some(f => f.binary)) signals.push("binary")
  return { changeTypes, riskCategories, signals, byKind }
}

// ── range freeze ──────────────────────────────────────────────────────────

async function freezeRange(
  git: GitRunner,
  cwd: string,
  base: string | undefined,
  head: string | undefined,
  timeoutMs: number,
): Promise<{ range?: FrozenRange; note?: string }> {
  try {
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"], timeoutMs)).trim()
    const headSha = (await git(root, ["rev-parse", "--verify", "--quiet", `${head ?? "HEAD"}^{commit}`], timeoutMs)).trim()
    const baseSha = base
      ? (await git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], timeoutMs)).trim()
      : (await git(root, ["merge-base", DEFAULT_BASE_REF, headSha], timeoutMs)).trim()
    if (!root || !headSha || !baseSha) return { note: "range could not be frozen (empty ref)" }
    return { range: { root, baseSha, headSha } }
  } catch (e) {
    return { note: `range could not be frozen: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export async function collectEvidence(opts: CollectEvidenceOptions): Promise<CollectedEvidence> {
  const git = opts.git ?? defaultGit
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EVIDENCE_TIMEOUT_MS
  const maxFiles = opts.maxFiles ?? DEFAULT_EVIDENCE_MAX_FILES
  const notes: string[] = []
  const frozen = await freezeRange(git, opts.cwd, opts.base, opts.head, timeoutMs)
  if (frozen.note) notes.push(frozen.note)
  const range = frozen.range
  const refs = range ? [`range:${range.baseSha.slice(0, 12)}..${range.headSha.slice(0, 12)}`] : []

  if (opts.supplied) {
    const { evidence, withheld } = sanitizeEvidence(opts.policy, opts.supplied)
    const supplied = Array.isArray(evidence.evidenceRefs) ? (evidence.evidenceRefs as unknown[]) : []
    const complete = evidence.complete !== false && !(typeof evidence.completeness === "number" && evidence.completeness < 1)
    return {
      evidence: {
        ...evidence,
        complete,
        evidenceRefs: [...new Set([...supplied.filter((r): r is string => typeof r === "string"), ...refs])],
      },
      ...(range ? { range } : {}),
      complete,
      withheld,
      notes,
    }
  }

  if (!range) {
    return {
      evidence: { complete: false, completeness: 0, evidenceRefs: [] },
      complete: false,
      withheld: [],
      notes,
    }
  }

  let files: FileStat[] = []
  let complete = true
  try {
    const out = await git(
      range.root,
      ["diff", "--numstat", "--no-renames", "-z", range.baseSha, range.headSha],
      timeoutMs,
    )
    files = parseNumstatZ(out)
  } catch (e) {
    complete = false
    notes.push(`diff stat failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  let truncated = false
  if (files.length > maxFiles) {
    files = files.slice(0, maxFiles)
    truncated = true
    complete = false
    notes.push(`diff stat truncated at ${maxFiles} files`)
  }

  const cls = classify(files)
  const raw: Record<string, unknown> = {
    changeCounts: {
      files: files.length,
      additions: files.reduce((n, f) => n + f.added, 0),
      deletions: files.reduce((n, f) => n + f.deleted, 0),
      ...cls.byKind,
    },
    changeTypes: cls.changeTypes,
    riskCategories: cls.riskCategories,
    signals: cls.signals,
    complete,
    completeness: complete ? 1 : truncated ? 0.5 : 0,
    evidenceRefs: [...refs, `files:${files.length}${truncated ? "+" : ""}`],
  }
  if (opts.policy.evidence.allowPaths) raw.paths = files.slice(0, MAX_PATHS_EXPORTED).map(f => f.path)

  const { evidence, withheld } = sanitizeEvidence(opts.policy, raw)
  // A path export the policy did not opt into is a withheld class, reported
  // by name so the trace shows what stayed home.
  const classesHeld = opts.policy.evidence.allowPaths ? [] : ["paths"]
  return {
    evidence,
    range,
    complete,
    withheld: [...new Set([...withheld, ...classesHeld])].sort(),
    notes,
  }
}

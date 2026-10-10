/**
 * On-disk layout + output ceilings for the workflow runner's run history.
 *
 * Replaces the single `workflow-runs.json` (the whole registry re-stringified
 * and sync-written on every flush, every run's raw step outputs resident
 * forever) with ONE FILE PER RUN under `<persistPath minus .json>/`:
 *
 *   <runId>.jsonl   line 1 = slim header (the run WITHOUT step outputs /
 *                   final output / input / startStages) — read alone at boot to
 *                   build the in-memory index;
 *                   line 2 = the full run, outputs bounded by the ceilings
 *   <runId>.lease   tiny `{ownerId, heartbeatAt}` sidecar, rewritten by the
 *                   lease heartbeat in place of the run file
 *
 * A step output (or a run's final output) over its ceiling is stored as a
 * {@link BoundedOutputRef} — bounded preview + pointer — and the FULL
 * serialized value is kept as a per-run file under
 * `<runsRoot>/<runId>/step-outputs/`.
 */

import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import { join } from "node:path"
import type { WorkflowRun } from "./workflow-runner.js"

// ── Output ceilings ──────────────────────────────────────────────────

export interface WorkflowOutputLimits {
  /** A step output whose JSON exceeds this is stored as preview + pointer. */
  stepInlineBytes: number
  /** Preview length (characters of the JSON text) kept for a truncated output. */
  previewChars: number
  /** Per-run budget: the total of every inline output + preview kept on the
   *  run record. Once spent, further outputs keep a pointer and no preview. */
  runBudgetBytes: number
  /** Same ceiling for the run's own final `output`. */
  runOutputInlineBytes: number
  /** Cap (characters) for `run.error` / `step.error`. */
  errorChars: number
}

export const DEFAULT_OUTPUT_LIMITS: WorkflowOutputLimits = {
  stepInlineBytes: 8 * 1024,
  previewChars: 2 * 1024,
  runBudgetBytes: 128 * 1024,
  runOutputInlineBytes: 32 * 1024,
  errorChars: 8 * 1024,
}

export const STEP_OUTPUT_REF_PREFIX = "step-output:"
export const RUN_OUTPUT_REF = "run-output"

/** What replaces an over-ceiling output on the run record. `ref` is the key
 *  `readArtifact` / `workflow_artifact_get` resolve to the full value. */
export interface BoundedOutputRef {
  truncated: true
  /** Size of the full serialized value. */
  bytes: number
  /** Head of the serialized value (JSON text, not necessarily valid JSON). */
  preview: string
  ref: string
}

export function isBoundedOutputRef(v: unknown): v is BoundedOutputRef {
  if (v === null || typeof v !== "object") return false
  const o = v as Partial<BoundedOutputRef>
  return (
    o.truncated === true &&
    typeof o.ref === "string" &&
    (o.ref === RUN_OUTPUT_REF || o.ref.startsWith(STEP_OUTPUT_REF_PREFIX))
  )
}

export function stepOutputRef(label: string, part?: "gate"): string {
  return `${STEP_OUTPUT_REF_PREFIX}${label}${part ? `:${part}` : ""}`
}

export function clipError(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Apply a ceiling to one value. Returns the value to store, the budget it
 * spent, and — when it was truncated — the full serialized text to spill.
 */
export function boundOutput(
  value: unknown,
  ref: string,
  opts: { inlineBytes: number; previewChars: number; budgetLeft: number },
): { stored: unknown; spent: number; spill?: string } {
  if (value === undefined || isBoundedOutputRef(value)) return { stored: value, spent: 0 }
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    return { stored: { truncated: true, bytes: 0, preview: "[unserializable output]", ref } satisfies BoundedOutputRef, spent: 0 }
  }
  if (text === undefined) return { stored: value, spent: 0 }
  const bytes = Buffer.byteLength(text)
  if (bytes <= opts.inlineBytes && bytes <= opts.budgetLeft) return { stored: value, spent: bytes }
  const preview = text.slice(0, Math.max(0, Math.min(opts.previewChars, opts.budgetLeft)))
  const stored: BoundedOutputRef = { truncated: true, bytes, preview, ref }
  return { stored, spent: Buffer.byteLength(preview), spill: text }
}

// ── Paths ────────────────────────────────────────────────────────────

const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/

/** `<persistPath minus .json>` — the per-run directory next to the legacy file. */
export function runStoreDir(persistPath: string): string {
  return persistPath.endsWith(".json") ? persistPath.slice(0, -".json".length) : `${persistPath}.d`
}

export function runFilePath(dir: string, runId: string): string | undefined {
  return SAFE_RUN_ID.test(runId) ? join(dir, `${runId}.jsonl`) : undefined
}

export function leaseFilePath(dir: string, runId: string): string | undefined {
  return SAFE_RUN_ID.test(runId) ? join(dir, `${runId}.lease`) : undefined
}

/** Absolute path of the spill file for a bounded-output `ref`, or undefined
 *  for an unsafe runId / unrecognised ref. */
export function spillFilePath(runsRoot: string, runId: string, ref: string): string | undefined {
  if (!SAFE_RUN_ID.test(runId)) return undefined
  const base = join(runsRoot, runId, "step-outputs")
  if (ref === RUN_OUTPUT_REF) return join(base, "run-output.json")
  if (!ref.startsWith(STEP_OUTPUT_REF_PREFIX)) return undefined
  const label = ref.slice(STEP_OUTPUT_REF_PREFIX.length)
  const hash = createHash("sha1").update(label).digest("hex").slice(0, 10)
  return join(base, `s-${encodeURIComponent(label).slice(0, 100)}-${hash}.json`)
}

/** Workspace-relative path, as an artifact entry would report it. */
export function spillRelativePath(runsRoot: string, runId: string, ref: string): string | undefined {
  const abs = spillFilePath(runsRoot, runId, ref)
  return abs === undefined ? undefined : abs.slice(join(runsRoot, runId).length + 1)
}

// ── Atomic writes ────────────────────────────────────────────────────

let tmpSeq = 0
const tmpName = (path: string): string => `${path}.tmp.${process.pid}.${tmpSeq++}`

export async function writeFileAtomic(path: string, dir: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = tmpName(path)
  try {
    await writeFile(tmp, text, "utf8")
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

export function writeFileAtomicSync(path: string, dir: string, text: string): void {
  mkdirSync(dir, { recursive: true })
  const tmp = tmpName(path)
  try {
    writeFileSync(tmp, text, "utf8")
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

// ── Run files ────────────────────────────────────────────────────────

function slimStep(step: WorkflowRun["stages"][number]["steps"][number]): WorkflowRun["stages"][number]["steps"][number] {
  const { output: _output, gateReport, ...rest } = step
  return {
    ...rest,
    ...(gateReport !== undefined
      ? { gateReport: { ok: gateReport.ok, exitCode: gateReport.exitCode, attempt: gateReport.attempt, report: undefined } }
      : {}),
  }
}

/**
 * The run without anything unbounded-in-practice: no step outputs / gate
 * report bodies, no final `output`, no `input` / `startStages` (retry
 * plumbing), no lease. Stages, steps, status, timestamps, errors, artifacts
 * and the awaiting-* envelopes stay — everything `list()` / activities /
 * approve-reject need.
 */
export function slimRun(run: WorkflowRun): WorkflowRun {
  const { output: _o, startStages: _s, input: _i, lease: _l, ...rest } = run
  return { ...rest, stages: run.stages.map(st => ({ ...st, steps: st.steps.map(slimStep) })) }
}

export function serializeRunFile(run: WorkflowRun): string {
  const { lease: _l, ...full } = run
  return `${JSON.stringify(slimRun(run))}\n${JSON.stringify(full)}\n`
}

function isRunLike(v: unknown): v is WorkflowRun {
  return v !== null && typeof v === "object" && typeof (v as WorkflowRun).runId === "string" && Array.isArray((v as WorkflowRun).stages)
}

/** Line 1 of a run file — the slim header. Reads only the first block(s). */
export function readRunHeader(file: string): WorkflowRun | undefined {
  let fd: number
  try {
    fd = openSync(file, "r")
  } catch {
    return undefined
  }
  try {
    const parts: Buffer[] = []
    const buf = Buffer.allocUnsafe(64 * 1024)
    let pos = 0
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos)
      if (n === 0) break
      const nl = buf.subarray(0, n).indexOf(0x0a)
      if (nl !== -1) {
        parts.push(Buffer.from(buf.subarray(0, nl)))
        break
      }
      parts.push(Buffer.from(buf.subarray(0, n)))
      pos += n
    }
    const parsed: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"))
    return isRunLike(parsed) ? parsed : undefined
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/** Line 2 of a run file — the full (bounded) run. Falls back to the header
 *  for a file with no body line. */
export function readRunFull(file: string): WorkflowRun | undefined {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  try {
    const nl = text.indexOf("\n")
    if (nl === -1) return undefined
    const bodyEnd = text.indexOf("\n", nl + 1)
    const body = text.slice(nl + 1, bodyEnd === -1 ? undefined : bodyEnd)
    const parsed: unknown = body.trim() === "" ? JSON.parse(text.slice(0, nl)) : JSON.parse(body)
    return isRunLike(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function listRunIds(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => f.slice(0, -".jsonl".length))
      .filter(id => SAFE_RUN_ID.test(id))
  } catch {
    return []
  }
}

export function listLeaseRunIds(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith(".lease"))
      .map(f => f.slice(0, -".lease".length))
  } catch {
    return []
  }
}

export async function writeLeaseFile(dir: string, runId: string, lease: { ownerId: string; heartbeatAt: string }): Promise<void> {
  const path = leaseFilePath(dir, runId)
  if (path !== undefined) await writeFileAtomic(path, dir, JSON.stringify(lease))
}

export function removeLeaseFileSync(dir: string, runId: string): void {
  const path = leaseFilePath(dir, runId)
  if (path !== undefined) rmSync(path, { force: true })
}

export async function removeLeaseFile(dir: string, runId: string): Promise<void> {
  const path = leaseFilePath(dir, runId)
  if (path !== undefined) await rm(path, { force: true })
}

// ── Spill files (full outputs) ───────────────────────────────────────

export async function writeSpill(runsRoot: string, runId: string, ref: string, text: string): Promise<void> {
  const path = spillFilePath(runsRoot, runId, ref)
  if (path === undefined) return
  await writeFileAtomic(path, join(runsRoot, runId, "step-outputs"), text)
}

export function writeSpillSync(runsRoot: string, runId: string, ref: string, text: string): void {
  const path = spillFilePath(runsRoot, runId, ref)
  if (path === undefined) return
  writeFileAtomicSync(path, join(runsRoot, runId, "step-outputs"), text)
}

/** The full value behind a ref, parsed — `undefined` when the file is gone,
 *  unparseable, or larger than `maxBytes`. */
export function readSpillValue(runsRoot: string, runId: string, ref: string, maxBytes: number): { value: unknown } | undefined {
  const path = spillFilePath(runsRoot, runId, ref)
  if (path === undefined) return undefined
  try {
    if (statSync(path).size > maxBytes) return undefined
    return { value: JSON.parse(readFileSync(path, "utf8")) }
  } catch {
    return undefined
  }
}

// ── Applying ceilings to a whole run (migration) ─────────────────────

/**
 * Bound every step output, gate-report body, final output and error of a run
 * IN PLACE, handing each spilled full value to `spill`. Idempotent: values
 * that are already {@link BoundedOutputRef}s are left alone.
 */
export function applyOutputCeilings(
  run: WorkflowRun,
  limits: WorkflowOutputLimits,
  spill: (ref: string, text: string) => void,
): void {
  let budgetLeft = limits.runBudgetBytes
  for (const stage of run.stages) {
    for (const step of stage.steps) {
      if (step.output !== undefined) {
        const r = boundOutput(step.output, stepOutputRef(step.label), {
          inlineBytes: limits.stepInlineBytes,
          previewChars: limits.previewChars,
          budgetLeft,
        })
        step.output = r.stored
        budgetLeft -= r.spent
        if (r.spill !== undefined) spill(stepOutputRef(step.label), r.spill)
      }
      if (step.gateReport?.report !== undefined) {
        const ref = stepOutputRef(step.label, "gate")
        const r = boundOutput(step.gateReport.report, ref, {
          inlineBytes: limits.stepInlineBytes,
          previewChars: limits.previewChars,
          budgetLeft,
        })
        step.gateReport.report = r.stored
        budgetLeft -= r.spent
        if (r.spill !== undefined) spill(ref, r.spill)
      }
      if (step.error !== undefined) step.error = clipError(step.error, limits.errorChars)
    }
  }
  if (run.output !== undefined) {
    const r = boundOutput(run.output, RUN_OUTPUT_REF, {
      inlineBytes: limits.runOutputInlineBytes,
      previewChars: limits.previewChars,
      budgetLeft: limits.runOutputInlineBytes,
    })
    run.output = r.stored
    if (r.spill !== undefined) spill(RUN_OUTPUT_REF, r.spill)
  }
  if (run.error !== undefined) run.error = clipError(run.error, limits.errorChars)
}

// ── Legacy `workflow-runs.json` migration ────────────────────────────

/** Yield the raw text of each top-level object of a JSON array file without
 *  ever holding the whole file: a 280 MB registry is split one run at a time. */
function* iterateArrayElements(path: string): Generator<string> {
  const fd = openSync(path, "r")
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    const decoder = new StringDecoder("utf8")
    let depth = 0
    let inStr = false
    let esc = false
    let inElem = false
    let cur: string[] = []
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      const chunk = decoder.write(buf.subarray(0, n))
      let segStart = inElem ? 0 : -1
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk.charCodeAt(i)
        if (inStr) {
          if (esc) esc = false
          else if (c === 92) esc = true
          else if (c === 34) inStr = false
          continue
        }
        if (c === 34) {
          inStr = true
        } else if (c === 123 || c === 91) {
          depth++
          if (depth === 2 && c === 123) {
            inElem = true
            segStart = i
          }
        } else if (c === 125 || c === 93) {
          depth--
          if (depth === 1 && inElem && c === 125) {
            cur.push(chunk.slice(segStart, i + 1))
            const text = cur.length === 1 ? cur[0]! : cur.join("")
            cur = []
            inElem = false
            segStart = -1
            yield text
          }
        }
      }
      if (inElem) cur.push(chunk.slice(segStart))
    }
  } finally {
    closeSync(fd)
  }
}

export interface LegacyMigrationResult {
  /** Runs written to the per-run layout by this call. */
  migrated: number
  /** Runs already present in the new layout (a re-run after a crash). */
  alreadyPresent: number
  /** Elements that were not a usable run record (kept only in the .bak). */
  skipped: number
  /** Outputs spilled to per-run artifact files. */
  outputsSpilled: number
  legacyBytes: number
  /** Total bytes of the per-run files written by this call. */
  newBytes: number
  bakPath: string
}

/**
 * One-shot, idempotent, crash-safe migration of the legacy single-file
 * registry. Every run — including `running` / `awaiting-*` ones, whose status
 * is carried over verbatim for the boot loader to interpret — is split into
 * its own file with the output ceilings applied (full outputs spilled to
 * artifact files). The legacy file is renamed to `.bak` LAST, so a crash
 * anywhere earlier leaves it in place and the next boot simply redoes the
 * (skip-if-present) split.
 */
export function migrateLegacyRuns(opts: {
  persistPath: string
  dir: string
  runsRoot: string
  limits: WorkflowOutputLimits
}): LegacyMigrationResult | undefined {
  const { persistPath, dir, runsRoot, limits } = opts
  if (!existsSync(persistPath)) return undefined
  const result: LegacyMigrationResult = {
    migrated: 0,
    alreadyPresent: 0,
    skipped: 0,
    outputsSpilled: 0,
    legacyBytes: 0,
    newBytes: 0,
    bakPath: "",
  }
  try {
    result.legacyBytes = statSync(persistPath).size
  } catch {
    return undefined
  }
  mkdirSync(dir, { recursive: true })
  for (const raw of iterateArrayElements(persistPath)) {
    // `runId` is the first key of every record the runner ever wrote — read it
    // off the head so an already-migrated run skips the JSON.parse entirely.
    const head = /"runId"\s*:\s*"([A-Za-z0-9_-]{1,128})"/.exec(raw.slice(0, 256))
    const headPath = head ? runFilePath(dir, head[1]!) : undefined
    if (headPath !== undefined && existsSync(headPath)) {
      result.alreadyPresent++
      continue
    }
    let run: unknown
    try {
      run = JSON.parse(raw)
    } catch {
      result.skipped++
      continue
    }
    if (!isRunLike(run)) {
      result.skipped++
      continue
    }
    const file = runFilePath(dir, run.runId)
    if (file === undefined) {
      result.skipped++
      continue
    }
    if (existsSync(file)) {
      result.alreadyPresent++
      continue
    }
    applyOutputCeilings(run, limits, (ref, text) => {
      writeSpillSync(runsRoot, run.runId, ref, text)
      result.outputsSpilled++
    })
    const text = serializeRunFile(run)
    writeFileAtomicSync(file, dir, text)
    result.newBytes += Buffer.byteLength(text)
    result.migrated++
  }
  let bak = `${persistPath}.bak`
  if (existsSync(bak)) bak = `${persistPath}.bak.${Date.now()}`
  renameSync(persistPath, bak)
  result.bakPath = bak
  return result
}

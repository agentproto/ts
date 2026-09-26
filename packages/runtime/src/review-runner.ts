/**
 * Review runner — the daemon host for `@agentproto/review`.
 *
 * The pure package parses REVIEW.md and compiles a binding into an ordinary
 * AIP-15 workflow; this module supplies everything that touches the world:
 *
 *   1. resolve the repo + range — `merge-base(<target.base>, HEAD)..HEAD`
 *      unless the caller pins `base`/`head`;
 *   2. ledger pre-check — a clean `pass`/`block` already recorded for the
 *      same `(repoRemote, manifestSha, binding, rangeSha)` (and the same
 *      rubric digests) is returned with `cached: true`, nothing runs;
 *   3. execute the compiled workflow through `@agentproto/workflow-runtime`'s
 *      `compileWorkflow` + `runWorkflow` — prepare steps (the engine's own
 *      gate runner), then the FREEZE (head resolved after prepare), then the
 *      lanes in parallel through {@link createReviewLaneExecutor}, then the
 *      fan-in verdict;
 *   4. build the attestation and write it to the ledger.
 *
 * Lanes: command lanes run `sh -c <run>` in their own process group with a
 * hard timeout; agent lanes spawn a CHILD REVIEWER SESSION through
 * {@link ReviewerSessionHost} — in the daemon, {@link createDaemonReviewerHost},
 * which uses the same `spawnAgentSession` core `agent_start` uses and kills
 * the session through the registry on timeout/cancel (a child session, never
 * an orphan pid). The reviewer gets a pointer-style prompt (range + rubric
 * path) and writes a structured verdict file under the ledger's run dir —
 * outside the reviewed tree.
 *
 * Async pattern mirrors `WorkflowRunner`: `start()` returns a run record
 * immediately and executes in the background; `status()` polls; `wait()`
 * blocks. Runs live in memory for the daemon's lifetime; the ATTESTATION is
 * what persists (the ledger), and `status()` falls back to it for a run that
 * finished before a daemon restart.
 */

import { spawn as spawnChild, execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import {
  buildAgentLanePrompt,
  buildAttestation,
  compileReview,
  manifestSha as hashManifest,
  parseAgentLaneReport,
  parseReviewManifest,
  rangeSha,
  resolveBinding,
  sha256Hex,
  type AgentCheck,
  type Attestation,
  type LaneOutcome,
  type LaneResult,
  type ReviewLaneExecutor,
  type ReviewOutcome,
  type ReviewTarget,
  type RubricDigest,
} from "@agentproto/review"
import { compileWorkflow, runWorkflow } from "@agentproto/workflow-runtime"
import { repoSlug, type LedgerEntry, type ReviewLedger } from "./review-ledger.js"

// ── git ──────────────────────────────────────────────────────────────

/** Run git in `cwd`; resolve trimmed stdout, reject with git's stderr. */
export function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message).trim()
        reject(new Error(`git ${args.join(" ")} failed: ${detail}`))
        return
      }
      resolvePromise(String(stdout).trim())
    })
  })
}

/**
 * Normalize a git remote URL so SSH and HTTPS clones of the same repo agree:
 * `git@github.com:agentproto/ts.git` and `https://user@github.com/agentproto/ts`
 * both become `github.com/agentproto/ts`. Credentials are always stripped.
 */
export function normalizeRemote(url: string): string {
  let s = url.trim()
  const scp = s.match(/^[^@/]+@([^:/]+):(.+)$/)
  if (scp) s = `${scp[1]}/${scp[2]}`
  else s = s.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "")
  return s.replace(/\.git$/, "").replace(/\/+$/, "")
}

/** Resolve the checkout root and a stable repo identity for `cwd`. */
export async function resolveRepo(cwd: string): Promise<{ root: string; repoRemote: string }> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"])
  const url = await git(root, ["remote", "get-url", "origin"]).catch(() => undefined)
  return { root, repoRemote: url ? normalizeRemote(url) : `local:${root}` }
}

/** Resolve a ref to a full commit sha. */
export const revParse = (root: string, ref: string): Promise<string> =>
  git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => {
    throw new Error(`cannot resolve '${ref}' to a commit in ${root}`)
  })

/** Tracked-file changes present? (Untracked files don't count — they can't
 *  change what a committed range contains.) */
export async function isDirty(root: string): Promise<boolean> {
  const out = await git(root, ["status", "--porcelain", "--untracked-files=no"])
  return out.length > 0
}

// ── lane execution ───────────────────────────────────────────────────

const OUTPUT_KEEP_CHARS = 64 * 1024
const KILL_GRACE_MS = 5_000

/** Kill a detached child's whole process group (the shell AND whatever it
 *  spawned), falling back to the child itself. */
function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}

/** Run one command lane: `sh -c <command>` in its own process group, output
 *  captured (tail-bounded), hard-killed on timeout or cancel. */
export function runShellLane(input: {
  command: string
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<LaneOutcome> {
  return new Promise((resolvePromise) => {
    let output = ""
    let settled = false
    let reason: "timeout" | "cancelled" | undefined
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8")
      if (output.length > OUTPUT_KEEP_CHARS * 2) output = output.slice(-OUTPUT_KEEP_CHARS)
    }
    const child = spawnChild("sh", ["-c", input.command], {
      cwd: input.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)

    const stop = (why: "timeout" | "cancelled") => {
      if (settled || reason) return
      reason = why
      killTree(child.pid, "SIGTERM")
      setTimeout(() => killTree(child.pid, "SIGKILL"), KILL_GRACE_MS).unref()
    }
    const timer = setTimeout(() => stop("timeout"), input.timeoutMs)
    const onAbort = () => stop("cancelled")
    input.signal?.addEventListener("abort", onAbort, { once: true })

    const finish = (outcome: LaneOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
      resolvePromise(outcome)
    }
    child.on("error", (err) => finish({ outcome: "skipped", error: `could not start: ${err.message}` }))
    child.on("close", (code, sig) => {
      const tail = output.slice(-OUTPUT_KEEP_CHARS)
      if (reason === "timeout") {
        finish({ outcome: "timeout", error: `exceeded ${input.timeoutMs}ms and was killed`, output: tail })
      } else if (reason === "cancelled") {
        finish({ outcome: "skipped", error: "review cancelled while this lane was running" })
      } else {
        finish({ outcome: "exited", exitCode: code ?? (sig ? 128 : 1), output: tail })
      }
    })
  })
}

/** Outcome of one reviewer session's run. */
export type ReviewerRunResult =
  | { status: "ended"; sessionId: string; preset: string }
  | { status: "timeout"; sessionId: string; preset: string }
  | { status: "failed"; error: string; sessionId?: string; preset?: string }

/**
 * The agent-lane executor seam: spawn a reviewer session under a harness
 * preset, run ONE turn with `prompt`, and stop it — killing it through the
 * session lifecycle on timeout or cancel. The daemon wires
 * {@link createDaemonReviewerHost}; tests wire a fake.
 */
export interface ReviewerSessionHost {
  run(input: {
    preset: string
    cwd: string
    prompt: string
    label: string
    timeoutMs: number
    parentSessionId?: string
    signal?: AbortSignal
  }): Promise<ReviewerRunResult>
}

export interface ReviewLaneExecutorContext {
  runId: string
  reviewId: string
  repoRoot: string
  manifestPath: string
  /** Directory the agent lanes' verdict files are written under. */
  runDir: string
  reviewers?: ReviewerSessionHost
  parentSessionId?: string
}

/** The daemon's {@link ReviewLaneExecutor}: subprocess command lanes, child
 *  reviewer sessions for agent lanes. */
export function createReviewLaneExecutor(ctx: ReviewLaneExecutorContext): ReviewLaneExecutor {
  const runAgent = async (check: AgentCheck, target: ReviewTarget, signal?: AbortSignal): Promise<LaneOutcome> => {
    if (!ctx.reviewers) {
      return {
        outcome: "skipped",
        error: "agent lanes are not available on this daemon (started without an agent adapter resolver)",
      }
    }
    const rubricPath = resolve(dirname(ctx.manifestPath), check.rubric)
    try {
      await readFile(rubricPath)
    } catch {
      return { outcome: "skipped", error: `rubric not found: ${rubricPath}` }
    }
    const verdictPath = join(ctx.runDir, `${check.id}.verdict.json`)
    await mkdir(ctx.runDir, { recursive: true })
    await rm(verdictPath, { force: true })
    const result = await ctx.reviewers.run({
      preset: check.preset,
      cwd: ctx.repoRoot,
      prompt: buildAgentLanePrompt({ reviewId: ctx.reviewId, check, target, rubricPath, verdictPath }),
      label: `review:${ctx.reviewId}:${check.id}`,
      timeoutMs: check.timeoutMs,
      ...(ctx.parentSessionId ? { parentSessionId: ctx.parentSessionId } : {}),
      ...(signal ? { signal } : {}),
    })
    if (result.status === "failed") {
      return {
        outcome: "skipped",
        error: result.error,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        preset: result.preset ?? check.preset,
      }
    }
    if (result.status === "timeout") {
      return {
        outcome: "timeout",
        error: `reviewer exceeded ${check.timeoutMs}ms and was killed`,
        sessionId: result.sessionId,
        preset: result.preset,
      }
    }
    let raw: string
    try {
      raw = await readFile(verdictPath, "utf8")
    } catch {
      return {
        outcome: "skipped",
        error: `reviewer ended its turn without writing ${verdictPath}`,
        sessionId: result.sessionId,
        preset: result.preset,
      }
    }
    try {
      return { outcome: "reported", report: parseAgentLaneReport(raw), sessionId: result.sessionId, preset: result.preset }
    } catch (err) {
      return {
        outcome: "skipped",
        error: err instanceof Error ? err.message : String(err),
        sessionId: result.sessionId,
        preset: result.preset,
      }
    }
  }

  return {
    async runLane(lane, signal) {
      if (lane.kind === "command") {
        const cwd = lane.check.cwd
          ? isAbsolute(lane.check.cwd)
            ? lane.check.cwd
            : resolve(ctx.repoRoot, lane.check.cwd)
          : ctx.repoRoot
        return runShellLane({
          command: lane.command,
          cwd,
          timeoutMs: lane.check.timeoutMs,
          ...(signal ? { signal } : {}),
        })
      }
      return runAgent(lane.check, lane.target, signal)
    },
  }
}

// ── runner ───────────────────────────────────────────────────────────

export interface ReviewRunInput {
  /** Any directory inside the repo to review. */
  cwd: string
  /** REVIEW.md path — absolute, or relative to `cwd`. Default: `<repo root>/REVIEW.md`. */
  manifestPath?: string
  /** Binding name. Default: the sole binding, or `default`. */
  binding?: string
  /** Range base (ref or sha). Default: `merge-base(<target.base>, HEAD)`. */
  base?: string
  /** Range head (ref or sha). Default: `HEAD`, resolved AFTER prepare. */
  head?: string
  /** Ignore a cached ledger verdict and re-run. */
  nocache?: boolean
  /** Session the agent lanes' reviewer sessions nest under. */
  parentSessionId?: string
}

export type ReviewRunStatus = "running" | "done" | "failed" | "cancelled"

export interface ReviewRun {
  runId: string
  status: ReviewRunStatus
  startedAt: string
  endedAt?: string
  reviewId?: string
  binding?: string
  repoRemote?: string
  /** Lanes settled so far (live progress while `running`). */
  lanes: LaneResult[]
  /** Set once `done`. */
  attestation?: Attestation
  /** True when `attestation` was served from the ledger — nothing ran. */
  cached?: boolean
  /** Where the attestation was written in the ledger. */
  ledgerPath?: string
  error?: string
}

export interface ReviewRunner {
  start(input: ReviewRunInput): ReviewRun
  status(runId: string): Promise<ReviewRun | undefined>
  wait(runId: string): Promise<ReviewRun | undefined>
  cancel(runId: string): boolean
  readonly ledger: ReviewLedger
}

export interface CreateReviewRunnerOptions {
  ledger: ReviewLedger
  /** Agent-lane executor. Omitted ⇒ agent lanes are `skipped` (and the
   *  verdict therefore `incomplete`), never silently passed. */
  reviewers?: ReviewerSessionHost
  /** Attestor identity. Default: `agentproto-runtime@<hostname>`. */
  daemonId?: string
}

/** Placeholder values the daemon binds for every review. `{changed}` is a
 *  shell-quoted turbo filter for the packages changed since the range base
 *  (compose dependents with `...{changed}`). */
export function hostPlaceholders(baseSha: string): Record<string, string> {
  return { base: baseSha, changed: `'[${baseSha}]'` }
}

export function createReviewRunner(opts: CreateReviewRunnerOptions): ReviewRunner {
  const { ledger } = opts
  const daemonId = opts.daemonId ?? `agentproto-runtime@${hostname()}`
  const runs = new Map<string, { run: ReviewRun; done: Promise<void>; abort: AbortController }>()
  /** In-flight dedupe: an identical request joins the running run. */
  const inflight = new Map<string, string>()

  const requestKey = (i: ReviewRunInput) =>
    JSON.stringify([resolve(i.cwd), i.manifestPath ?? "", i.binding ?? "", i.base ?? "", i.head ?? "", !!i.nocache])

  async function execute(run: ReviewRun, input: ReviewRunInput, signal: AbortSignal): Promise<void> {
    const { root, repoRemote } = await resolveRepo(input.cwd)
    run.repoRemote = repoRemote
    const manifestPath = input.manifestPath
      ? resolve(input.cwd, input.manifestPath)
      : join(root, "REVIEW.md")
    const source = await readFile(manifestPath, "utf8").catch(() => {
      throw new Error(`no REVIEW.md at ${manifestPath}`)
    })
    const manifest = parseReviewManifest(source)
    const binding = resolveBinding(manifest, input.binding)
    run.reviewId = manifest.id
    run.binding = binding.name
    const mSha = hashManifest(source)

    const baseSha = input.base
      ? await revParse(root, input.base)
      : await git(root, ["merge-base", manifest.target.base, "HEAD"]).catch((err: Error) => {
          throw new Error(
            `cannot compute merge-base(${manifest.target.base}, HEAD) — pass 'base' explicitly or fetch the base ref (${err.message})`,
          )
        })

    const rubrics: RubricDigest[] = []
    for (const id of binding.checks) {
      const check = manifest.checks.find((c) => c.id === id)
      if (check?.kind !== "agent") continue
      const path = resolve(dirname(manifestPath), check.rubric)
      const bytes = await readFile(path).catch(() => undefined)
      if (bytes) rubrics.push({ check: check.id, path: check.rubric, sha256: sha256Hex(bytes) })
    }

    // Ledger pre-check against the CURRENT head. A prepare step that commits
    // moves the frozen head; on the next run the head already includes that
    // commit, so an idempotent prepare still converges onto a cache hit.
    if (!input.nocache) {
      const headNow = await revParse(root, input.head ?? "HEAD")
      if (!(await isDirty(root))) {
        const hit = await ledger.lookupCached(
          { repoRemote, manifestSha: mSha, binding: binding.name, rangeSha: rangeSha({ baseSha, headSha: headNow }) },
          rubrics,
        )
        if (hit) {
          run.attestation = hit.attestation
          run.lanes = hit.attestation.lanes
          run.cached = true
          return
        }
      }
    }

    let dirty = false
    const runDir = join(ledger.root, repoSlug(repoRemote), "runs", run.runId)
    const compiled = compileReview(manifest, {
      binding: binding.name,
      vars: hostPlaceholders(baseSha),
      signal,
      freeze: async () => {
        const headSha = await revParse(root, input.head ?? "HEAD")
        dirty = await isDirty(root)
        return { repoRemote, baseSha, headSha }
      },
      executor: createReviewLaneExecutor({
        runId: run.runId,
        reviewId: manifest.id,
        repoRoot: root,
        manifestPath,
        runDir,
        ...(opts.reviewers ? { reviewers: opts.reviewers } : {}),
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      }),
      onLaneSettled: (lane) => {
        run.lanes = [...run.lanes, lane]
      },
    })
    const workflow = compileWorkflow(compiled.workflow, { tools: {}, candidates: [] })
    const result = await runWorkflow({ workflow, cwd: root, signal })
    const outcome = result.output as ReviewOutcome

    const attestation = buildAttestation({
      runId: run.runId,
      reviewId: manifest.id,
      manifestSha: mSha,
      binding: binding.name,
      quorum: binding.quorum,
      target: outcome.target,
      lanes: outcome.lanes,
      attestor: { daemon: daemonId, presets: outcome.lanes.flatMap((l) => (l.preset ? [l.preset] : [])) },
      rubrics,
      dirty,
    })
    const entry: LedgerEntry = {
      attestation,
      host: {
        repoRoot: root,
        manifestPath,
        ...(manifest.verdict.exportDir ? { exportDir: resolve(root, manifest.verdict.exportDir) } : {}),
      },
    }
    run.ledgerPath = await ledger.put(entry)
    run.attestation = attestation
    run.lanes = attestation.lanes
    await rm(runDir, { recursive: true, force: true })
  }

  async function status(runId: string): Promise<ReviewRun | undefined> {
    const live = runs.get(runId)
    if (live) return live.run
    const entry = await ledger.findByRunId(runId)
    if (!entry) return undefined
    const a = entry.attestation
    return {
      runId,
      status: "done",
      startedAt: a.createdAt,
      endedAt: a.createdAt,
      reviewId: a.reviewId,
      binding: a.binding,
      repoRemote: a.target.repoRemote,
      lanes: a.lanes,
      attestation: a,
    }
  }

  return {
    ledger,
    status,
    start(input) {
      const key = requestKey(input)
      const existing = inflight.get(key)
      if (existing) {
        const live = runs.get(existing)
        if (live && live.run.status === "running") return live.run
      }
      const run: ReviewRun = {
        runId: `review-${randomUUID()}`,
        status: "running",
        startedAt: new Date().toISOString(),
        lanes: [],
      }
      const abort = new AbortController()
      inflight.set(key, run.runId)
      const done = execute(run, input, abort.signal)
        .then(() => {
          run.status = abort.signal.aborted ? "cancelled" : "done"
        })
        .catch((err: unknown) => {
          run.status = abort.signal.aborted ? "cancelled" : "failed"
          run.error = err instanceof Error ? err.message : String(err)
        })
        .finally(() => {
          run.endedAt = new Date().toISOString()
          if (inflight.get(key) === run.runId) inflight.delete(key)
        })
      runs.set(run.runId, { run, done, abort })
      return run
    },
    async wait(runId) {
      const live = runs.get(runId)
      if (live) {
        await live.done
        return live.run
      }
      return status(runId)
    },
    cancel(runId) {
      const live = runs.get(runId)
      if (!live || live.run.status !== "running") return false
      live.abort.abort()
      return true
    },
  }
}

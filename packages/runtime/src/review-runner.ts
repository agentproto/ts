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
 *   4. build the attestation and write it to the ledger. A CANCELLED run
 *      (`cancel()`, or superseded by a newer head — see `supersede`) writes
 *      nothing: nobody asked for its verdict any more.
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

import { spawn as spawnChild, execFile, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import {
  attestationSha256,
  buildAgentLanePrompt,
  buildAttestation,
  compileReview,
  ledgerKeyOf,
  manifestSha as hashManifest,
  parseAgentLaneReport,
  parseReviewManifest,
  rangeSha,
  resolveBinding,
  resolvePacks,
  sha256Hex,
  type AgentCheck,
  type Attestation,
  type LaneFallback,
  type LaneOutcome,
  type LaneResult,
  type PackDigest,
  type ReviewLaneExecutor,
  type ReviewOutcome,
  type ReviewPrRef,
  type ReviewRequester,
  type ReviewTarget,
  type RubricDigest,
} from "@agentproto/review"
import { compileWorkflow, runWorkflow } from "@agentproto/workflow-runtime"
import { repoSlug, withPr, type LedgerEntry, type ReviewLedger } from "./review-ledger.js"
import { composedFromRangeSha, findComposeCandidate } from "./review-compose.js"
import { createReviewPackLoader } from "./review-pack-loader.js"
import { resolvePrincipal, signAttestation } from "./review-signing.js"

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

/** The author of `sha` — `undefined` when git can't say. */
export async function commitAuthor(root: string, sha: string): Promise<{ name: string; email: string } | undefined> {
  const out = await git(root, ["log", "-1", "--format=%an%x00%ae", sha]).catch(() => undefined)
  if (!out) return undefined
  const [name, email] = out.split("\0")
  return name && email ? { name, email } : undefined
}

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
export type ReviewerRunResult = (
  | { status: "ended"; sessionId: string; preset: string; model?: string }
  | { status: "timeout"; sessionId: string; preset: string; model?: string }
  | { status: "failed"; error: string; sessionId?: string; preset?: string; model?: string }
) & {
  /** Reviewers that were unavailable BEFORE the one in `preset`, in order, each
   *  with its error. Set only when a `fallbackPresets` chain advanced past at
   *  least one reviewer; `preset`/`model`/`sessionId` always name the reviewer
   *  that produced this result. */
  fallbacks?: LaneFallback[]
}

/**
 * The agent-lane executor seam: spawn a reviewer session under a harness
 * preset, run ONE turn with `prompt`, and stop it — killing it through the
 * session lifecycle on timeout or cancel. The daemon wires
 * {@link createDaemonReviewerHost}; tests wire a fake.
 */
export interface ReviewerSessionHost {
  run(input: {
    preset: string
    /** Tried in order, after `preset`, only when the preceding reviewer was
     *  unavailable (never after a verdict, timeout, or cancel). */
    fallbackPresets?: string[]
    cwd: string
    prompt: string
    label: string
    timeoutMs: number
    parentSessionId?: string
    signal?: AbortSignal
  }): Promise<ReviewerRunResult>
}

/** Attestation composition wiring for `createReviewLaneExecutor` — omitted
 *  or `enabled: false` disables composition and every agent lane reviews the
 *  full frozen range, same as before Goal B. */
export interface ReviewComposeContext {
  enabled: boolean
  ledger: ReviewLedger
  manifestSha: string
  binding: string
  rubrics: RubricDigest[]
  /** `as` → this run's resolved pack digest — a lane whose check came from
   *  a `uses[]` pack additionally requires the candidate to carry an
   *  identical digest for that pack (see `review-compose.ts`). */
  packByNamespace?: Record<string, PackDigest>
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
  compose?: ReviewComposeContext
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
    const rubricPath = resolve(check.rubricBase ?? dirname(ctx.manifestPath), check.rubric)
    try {
      await readFile(rubricPath)
    } catch {
      return { outcome: "skipped", error: `rubric not found: ${rubricPath}` }
    }

    // Composition: an agent lane may reuse a prior PASSING attestation and
    // review only the delta on top of it — see review-compose.ts. Command
    // lanes never reach this function; only agent lanes compose.
    let promptTarget = target
    let composedFrom: LaneResult["composedFrom"] | undefined
    if (ctx.compose?.enabled) {
      const rubric = ctx.compose.rubrics.find((r) => r.check === check.id)
      // A namespaced check id (`<as>/<id>`) came from a uses[] pack — pin
      // composition to an identical pack digest too, not just the rubric.
      const namespace = check.id.includes("/") ? check.id.slice(0, check.id.indexOf("/")) : undefined
      const packDigest = namespace ? ctx.compose.packByNamespace?.[namespace] : undefined
      const candidate = rubric
        ? await findComposeCandidate({
            ledger: ctx.compose.ledger,
            repoRoot: ctx.repoRoot,
            repoRemote: target.repoRemote,
            manifestSha: ctx.compose.manifestSha,
            binding: ctx.compose.binding,
            checkId: check.id,
            rubricSha256: rubric.sha256,
            ...(packDigest ? { packDigest: { id: packDigest.id, alg: packDigest.alg, sha256: packDigest.sha256 } } : {}),
            baseSha: target.baseSha,
            headSha: target.headSha,
          })
        : undefined
      if (candidate) {
        const priorHeadSha = candidate.attestation.target.headSha
        promptTarget = { ...target, baseSha: priorHeadSha }
        composedFrom = {
          rangeSha: composedFromRangeSha(candidate),
          headSha: priorHeadSha,
          attestationSha256: attestationSha256(candidate.attestation),
        }
      }
    }

    // A pack-derived check id is namespaced (`<as>/<id>`) — flatten it for
    // the filename rather than creating a subdirectory under runDir.
    const verdictPath = join(ctx.runDir, `${check.id.replace(/\//g, "__")}.verdict.json`)
    await mkdir(ctx.runDir, { recursive: true })
    await rm(verdictPath, { force: true })
    const result = await ctx.reviewers.run({
      preset: check.preset,
      ...(check.fallbackPresets.length > 0 ? { fallbackPresets: check.fallbackPresets } : {}),
      cwd: ctx.repoRoot,
      prompt: buildAgentLanePrompt({
        reviewId: ctx.reviewId,
        check,
        target: promptTarget,
        rubricPath,
        verdictPath,
        ...(composedFrom ? { composedFrom: { priorHeadSha: composedFrom.headSha } } : {}),
      }),
      label: `review:${ctx.reviewId}:${check.id}`,
      timeoutMs: check.timeoutMs,
      ...(ctx.parentSessionId ? { parentSessionId: ctx.parentSessionId } : {}),
      ...(signal ? { signal } : {}),
    })
    const extras = {
      ...(result.model ? { model: result.model } : {}),
      ...(result.fallbacks?.length ? { fallbacks: result.fallbacks } : {}),
    }
    if (result.status === "failed") {
      return {
        outcome: "skipped",
        error: result.error,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        preset: result.preset ?? check.preset,
        ...extras,
      }
    }
    if (result.status === "timeout") {
      return {
        outcome: "timeout",
        error: `reviewer exceeded ${check.timeoutMs}ms and was killed`,
        sessionId: result.sessionId,
        preset: result.preset,
        ...extras,
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
        ...extras,
      }
    }
    try {
      return {
        outcome: "reported",
        report: parseAgentLaneReport(raw),
        sessionId: result.sessionId,
        preset: result.preset,
        ...extras,
        ...(composedFrom ? { composedFrom } : {}),
      }
    } catch (err) {
      return {
        outcome: "skipped",
        error: err instanceof Error ? err.message : String(err),
        sessionId: result.sessionId,
        preset: result.preset,
        ...extras,
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
  /** Let an agent lane reuse a prior passing attestation and review only the
   *  delta on top of it (attestation composition — see `review-compose.ts`).
   *  Default true. `nocache: true` implies `compose: false` — a caller
   *  asking to ignore the cache wants a full fresh review, not a partial
   *  one. Command lanes are never composed regardless of this flag. */
  compose?: boolean
  /** Session the agent lanes' reviewer sessions nest under. */
  parentSessionId?: string
  /** Session that requested the review — recorded as
   *  `attestation.requester.sessionId`. Default: `parentSessionId`. */
  requesterSessionId?: string
  /** The PR the range is being reviewed for, when the caller knows it —
   *  recorded as `attestation.pr` and as the entry's annotation link. */
  pr?: ReviewPrRef
  /** Before running, cancel in-flight runs for the same repo + binding + base
   *  whose head DIFFERS (an older push nobody will read the verdict of) — as
   *  long as that run is the same line of work: the same checkout, or a head
   *  that is an ancestor of this one. A sibling branch reviewed from another
   *  worktree off the same base is never cancelled. Gates should pass
   *  `true`; the default is `false`. */
  supersede?: boolean
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
  /** The resolved range base, once known. */
  baseSha?: string
  /** The range head: the pre-prepare head once resolved, then the frozen head. */
  headSha?: string
  /** The checkout the run reviews, once resolved. */
  repoRoot?: string
  /** Set on a run cancelled because a newer head superseded it. */
  supersededBy?: string
  /** Lanes settled so far (live progress while `running`). */
  lanes: LaneResult[]
  /** Set once `done`. */
  attestation?: Attestation
  /** True when `attestation` was served from the ledger — nothing ran. */
  cached?: boolean
  /** Where the attestation was written in the ledger. */
  ledgerPath?: string
  error?: string
  /** The session that requested this run (`input.requesterSessionId ??
   *  input.parentSessionId`), when known — mirrors
   *  `Attestation.requester.sessionId` for a run that hasn't (or never will)
   *  reach the ledger, so `review_ledger({includeRunning: true})` and the
   *  `session_tree` badge (WP-review-panel) can attribute an in-flight/
   *  cancelled/failed run to its requester without waiting for an
   *  attestation. */
  requesterSessionId?: string
  /** Set when the attestation was written UNSIGNED because signing failed
   *  (no `ssh-keygen`, an unreadable/unwritable key, …) — a signing failure
   *  never fails the review itself, but the reason is surfaced here rather
   *  than silently dropped. Absent when the attestation is signed, or the
   *  run never reached a verdict. */
  signingError?: string
}

export interface ReviewRunner {
  start(input: ReviewRunInput): ReviewRun
  status(runId: string): Promise<ReviewRun | undefined>
  wait(runId: string): Promise<ReviewRun | undefined>
  cancel(runId: string): boolean
  /** Every run this daemon process has started, newest first — running runs
   *  plus ones that settled (done/failed/cancelled) without a daemon
   *  restart in between. Runs live in memory only for the process lifetime
   *  (a restart loses this list, same as the rest of `runs` — the ATTESTATION
   *  is what persists, in the ledger). Backs `review_ledger({includeRunning:
   *  true})` and the `session_tree` review badge. */
  list(): ReviewRun[]
  readonly ledger: ReviewLedger
}

export interface CreateReviewRunnerOptions {
  ledger: ReviewLedger
  /** Agent-lane executor. Omitted ⇒ agent lanes are `skipped` (and the
   *  verdict therefore `incomplete`), never silently passed. */
  reviewers?: ReviewerSessionHost
  /** Attestor identity. Default: `agentproto-runtime@<hostname>`. */
  daemonId?: string
  /** Directory the review signing keypair lives in. Default:
   *  `~/.agentproto/keys` (see `review-signing.ts`'s `defaultReviewKeysDir`).
   *  Override for a throwaway HOME in a live-proof daemon, or a temp dir in
   *  tests — production code should leave this unset. */
  signingKeysDir?: string
  /** Overrides the resolved signing principal for every run (tests; a
   *  configured `review.principal`). Default: `git config user.email` of
   *  the reviewed repo, else a host-derived fallback — see
   *  `review-signing.ts`'s `resolvePrincipal`. */
  signingPrincipal?: string
  /** `env` passed to the `ssh-keygen` child processes signing shells out to
   *  — tests use this to simulate "ssh-keygen not on PATH" without touching
   *  the real PATH. Default: `process.env`. */
  signingEnv?: NodeJS.ProcessEnv
  /** Called once a run with a `requesterSessionId` reaches `done` — never
   *  for `failed`/`cancelled` (no verdict to report). Display-only: the
   *  daemon writes `text` into the requester's transcript as a `notice`
   *  (see `sessions.ts`'s `recordNotice`) so `session_story`/`live_session`
   *  show it — this never enqueues a prompt, touches the inbox, or starts a
   *  turn. Fire-and-forget from the runner's perspective; a throw here is
   *  swallowed. */
  notifyRequester?: (sessionId: string, text: string) => void
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
  const runs = new Map<
    string,
    /** `heads`: every head this run has been about (pre-prepare + frozen). */
    { run: ReviewRun; done: Promise<void>; abort: AbortController; heads: Set<string> }
  >()
  /** In-flight dedupe: an identical request joins the running run. */
  const inflight = new Map<string, string>()

  const requestKey = (i: ReviewRunInput) =>
    JSON.stringify([resolve(i.cwd), i.manifestPath ?? "", i.binding ?? "", i.base ?? "", i.head ?? "", !!i.nocache])

  async function execute(run: ReviewRun, input: ReviewRunInput, signal: AbortSignal): Promise<void> {
    const { root, repoRemote } = await resolveRepo(input.cwd)
    run.repoRemote = repoRemote
    run.repoRoot = root
    const manifestPath = input.manifestPath
      ? resolve(input.cwd, input.manifestPath)
      : join(root, "REVIEW.md")
    const source = await readFile(manifestPath, "utf8").catch(() => {
      throw new Error(`no REVIEW.md at ${manifestPath}`)
    })
    const parsed = parseReviewManifest(source)
    const packLoader = createReviewPackLoader({ repoRoot: root, manifestDir: dirname(manifestPath) })
    const { manifest, packs: packDigests, packByNamespace } = await resolvePacks(parsed, packLoader)
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
    const headNow = await revParse(root, input.head ?? "HEAD")
    run.baseSha = baseSha
    run.headSha = headNow
    runs.get(run.runId)?.heads.add(headNow)

    if (input.supersede) await supersedeStale(run)

    const rubrics: RubricDigest[] = []
    for (const id of binding.checks) {
      const check = manifest.checks.find((c) => c.id === id)
      if (check?.kind !== "agent") continue
      const path = resolve(check.rubricBase ?? dirname(manifestPath), check.rubric)
      const bytes = await readFile(path).catch(() => undefined)
      if (bytes) rubrics.push({ check: check.id, path: check.rubric, sha256: sha256Hex(bytes) })
    }

    // Ledger pre-check against the CURRENT head. A prepare step that commits
    // moves the frozen head; on the next run the head already includes that
    // commit, so an idempotent prepare still converges onto a cache hit.
    if (!input.nocache) {
      if (!(await isDirty(root))) {
        const hit = await ledger.lookupCached(
          { repoRemote, manifestSha: mSha, binding: binding.name, rangeSha: rangeSha({ baseSha, headSha: headNow }) },
          rubrics,
          packDigests,
        )
        if (hit) {
          run.attestation = hit.attestation
          run.lanes = hit.attestation.lanes
          run.cached = true
          return
        }
      }
    }

    // `nocache: true` asks for a full fresh review, so it implies
    // `compose: false` too — reusing a prior lane's verdict would be the
    // same kind of cache reuse `nocache` opts out of.
    const composeEnabled = input.nocache ? false : (input.compose ?? true)

    let dirty = false
    const runDir = join(ledger.root, repoSlug(repoRemote), "runs", run.runId)
    const compiled = compileReview(manifest, {
      binding: binding.name,
      vars: hostPlaceholders(baseSha),
      signal,
      freeze: async () => {
        const headSha = await revParse(root, input.head ?? "HEAD")
        dirty = await isDirty(root)
        run.headSha = headSha
        runs.get(run.runId)?.heads.add(headSha)
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
        compose: { enabled: composeEnabled, ledger, manifestSha: mSha, binding: binding.name, rubrics, packByNamespace },
      }),
      onLaneSettled: (lane) => {
        run.lanes = [...run.lanes, lane]
      },
    })
    const workflow = compileWorkflow(compiled.workflow, { tools: {}, candidates: [] })
    const result = await runWorkflow({ workflow, cwd: root, signal })
    const outcome = result.output as ReviewOutcome
    if (signal.aborted) {
      // Cancelled (or superseded): keep the live lane view, record nothing.
      if (outcome?.lanes) run.lanes = outcome.lanes
      await rm(runDir, { recursive: true, force: true })
      return
    }

    const requesterSessionId = run.requesterSessionId
    const gitAuthor = await commitAuthor(root, outcome.target.headSha)
    const requester: ReviewRequester = {
      ...(requesterSessionId ? { sessionId: requesterSessionId } : {}),
      ...(gitAuthor ? { gitAuthor } : {}),
    }
    const unsigned = buildAttestation({
      runId: run.runId,
      reviewId: manifest.id,
      manifestSha: mSha,
      binding: binding.name,
      quorum: binding.quorum,
      target: outcome.target,
      lanes: outcome.lanes,
      attestor: { daemon: daemonId, presets: outcome.lanes.flatMap((l) => (l.preset ? [l.preset] : [])) },
      rubrics,
      packs: packDigests,
      dirty,
      requester,
      ...(input.pr ? { pr: input.pr } : {}),
    })
    // Only the daemon signs (frozen design, Goal A). A signing failure (no
    // `ssh-keygen`, an unreadable key) NEVER fails the review — the
    // attestation is written unsigned, with the reason on the run view.
    const principal = await resolvePrincipal({ repoRoot: root, configuredPrincipal: opts.signingPrincipal })
    const signed = await signAttestation(unsigned, {
      principal,
      ...(opts.signingKeysDir ? { keysDir: opts.signingKeysDir } : {}),
      ...(opts.signingEnv ? { env: opts.signingEnv } : {}),
    })
    if (signed.error) run.signingError = signed.error
    const attestation: Attestation = signed.signature
      ? { ...unsigned, attestor: { ...unsigned.attestor, signature: signed.signature } }
      : unsigned
    const entry: LedgerEntry = {
      attestation,
      host: {
        repoRoot: root,
        manifestPath,
        ...(manifest.verdict.exportDir ? { exportDir: resolve(root, manifest.verdict.exportDir) } : {}),
      },
    }
    run.ledgerPath = await ledger.put(entry)
    if (input.pr) await ledger.updateAnnotations(ledgerKeyOf(attestation), withPr(input.pr))
    run.attestation = attestation
    run.lanes = attestation.lanes
    await rm(runDir, { recursive: true, force: true })
  }

  /** Cancel every OTHER running run with the same repo + binding + base but
   *  a different head than `run`, when it's the same line of work (same
   *  checkout, or its head is an ancestor of `run`'s). Runs whose range isn't
   *  resolved yet are left alone (nothing to compare). */
  async function supersedeStale(run: ReviewRun): Promise<void> {
    for (const [id, other] of [...runs]) {
      if (id === run.runId || other.run.status !== "running") continue
      const o = other.run
      if (!o.baseSha || !o.headSha) continue
      if (o.repoRemote !== run.repoRemote || o.binding !== run.binding || o.baseSha !== run.baseSha) continue
      if (o.headSha === run.headSha || other.heads.has(run.headSha!)) continue
      const sameLine =
        o.repoRoot === run.repoRoot ||
        (await git(run.repoRoot!, ["merge-base", "--is-ancestor", o.headSha, run.headSha!]).then(
          () => true,
          () => false,
        ))
      if (!sameLine || other.run.status !== "running") continue
      o.supersededBy = run.runId
      cancel(id)
    }
  }

  function cancel(runId: string): boolean {
    const live = runs.get(runId)
    if (!live || live.run.status !== "running") return false
    live.abort.abort()
    return true
  }

  /** Current HEAD of `cwd` — sync, only on the (rare) dedupe-join path. */
  function currentHead(cwd: string, ref: string): string | undefined {
    try {
      return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    } catch {
      return undefined
    }
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
        // Join only while the in-flight run is still about the head this
        // request would review: same request key but HEAD moved on (commit →
        // push → commit → push) is a NEW range, not a duplicate.
        if (live && live.run.status === "running") {
          const head = live.heads.size > 0 ? currentHead(resolve(input.cwd), input.head ?? "HEAD") : undefined
          if (head === undefined || live.heads.has(head)) return live.run
        }
      }
      const run: ReviewRun = {
        runId: `review-${randomUUID()}`,
        status: "running",
        startedAt: new Date().toISOString(),
        lanes: [],
        ...(input.requesterSessionId ?? input.parentSessionId
          ? { requesterSessionId: input.requesterSessionId ?? input.parentSessionId }
          : {}),
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
          // Display-only settle notice — done runs only (a failed/cancelled
          // run has no verdict to report). See `notifyRequester`'s doc.
          if (run.status === "done" && run.attestation && run.requesterSessionId && opts.notifyRequester) {
            const a = run.attestation
            const range = `${a.target.baseSha.slice(0, 7)}..${a.target.headSha.slice(0, 7)}`
            try {
              opts.notifyRequester(run.requesterSessionId, `review ${a.verdict} ${range} (${run.runId})`)
            } catch {
              // Best-effort — never let a notification failure affect the run.
            }
          }
        })
      runs.set(run.runId, { run, done, abort, heads: new Set() })
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
    cancel,
    list() {
      return [...runs.values()].map(v => v.run).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    },
  }
}

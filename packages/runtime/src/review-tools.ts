/**
 * MCP tools for the review primitive (`@agentproto/review`):
 *
 *   review_run     run a REVIEW.md binding over a git range → attestation
 *                  (ledger hit ⇒ the cached verdict, `cached: true`)
 *   review_status  poll a run started with `wait: false`
 *   review_cancel  cancel a running review (lane sessions are killed)
 *   review_ledger  list recorded attestations
 *   review_export  write one attestation out as a standalone JSON file
 *   review_pr      follow a recorded review to its GitHub PR (via `gh`):
 *                  link it, snapshot the PR's state/reviews/checks into the
 *                  entry's annotations, return the combined view
 *
 * Async pattern mirrors `workflow_start`/`workflow_status`: `review_run`
 * blocks by default (`wait: true`) — pass `wait: false` for long reviews and
 * poll `review_status` with the returned `runId`.
 *
 * Trust note: `review_run` executes the command checks the repo's own
 * REVIEW.md declares (`sh -c`), the same trust `workflow_run_file` extends to
 * a WORKFLOW.md's gate steps — not the `command_execute` allowlist, which
 * governs ad-hoc commands a remote caller composes.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { ledgerKeyOf, rangeSha as computeRangeSha, type Attestation, type ReviewPrRef } from "@agentproto/review"
import { withPr, withPrStatus, type LedgerAnnotations, type LedgerEntry, type ReviewLedger } from "./review-ledger.js"
import {
  execGh,
  fetchPrStatus,
  findPrForCommit,
  githubRepoOf,
  isRemoteOf,
  parsePrUrl,
  prHeadSha,
  prRef,
  toPrLookupError,
  type GhRunner,
} from "./review-pr.js"
import { resolveRepo, revParse, type ReviewRun, type ReviewRunner } from "./review-runner.js"

function jsonContent(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] }
}

function errorContent(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true }
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The reply shape for a run: verdict up front, full attestation once done. */
function runView(run: ReviewRun): Record<string, unknown> {
  return {
    runId: run.runId,
    status: run.status,
    ...(run.reviewId ? { reviewId: run.reviewId } : {}),
    ...(run.binding ? { binding: run.binding } : {}),
    ...(run.attestation ? { verdict: run.attestation.verdict } : {}),
    ...(run.cached ? { cached: true } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.signingError ? { signingError: run.signingError } : {}),
    ...(run.supersededBy ? { supersededBy: run.supersededBy } : {}),
    ...(run.status === "running" ? { lanes: run.lanes.map((l) => ({ id: l.id, status: l.status })) } : {}),
    ...(run.attestation ? { attestation: run.attestation } : {}),
    ...(run.ledgerPath ? { ledgerPath: run.ledgerPath } : {}),
  }
}

/** Compact `review_ledger` row. `pr`: the annotation link, else the one
 *  recorded in the attestation. `prState`: the most recent `review_pr`
 *  status snapshot's state, when one was ever fetched — the "last known PR
 *  state" the `agentproto_reviews` panel's list row shows without a second
 *  round-trip. `cwd`: the host-local checkout `review_run` ran in (never
 *  part of the attestation itself — it isn't portable — but real daemon-
 *  local metadata a caller on THIS daemon needs to pass back into a fresh
 *  `review_run`, e.g. the panel's "Re-run fresh" action). */
function ledgerRow(entry: LedgerEntry, annotations: LedgerAnnotations = {}): Record<string, unknown> {
  const a = entry.attestation
  const pr = annotations.pr ?? a.pr
  const lastPrStatus = annotations.prStatus?.at(-1)
  return {
    runId: a.runId,
    reviewId: a.reviewId,
    binding: a.binding,
    verdict: a.verdict,
    repoRemote: a.target.repoRemote,
    baseSha: a.target.baseSha,
    headSha: a.target.headSha,
    rangeSha: a.rangeSha,
    manifestSha: a.manifestSha,
    createdAt: a.createdAt,
    cwd: entry.host.repoRoot,
    ...(a.dirty ? { dirty: true } : {}),
    ...(a.requester ? { requester: a.requester } : {}),
    ...(pr ? { pr } : {}),
    ...(lastPrStatus ? { prState: lastPrStatus.state } : {}),
    // Compact signed/unsigned indicator — the full signature (and any
    // composedFrom lane detail) lives on the full attestation (review_export).
    signed: !!a.attestor.signature,
    lanes: a.lanes.map((l) => ({ id: l.id, status: l.status, blocking: l.blocking })),
  }
}

/** `review_ledger({includeRunning: true})` row for a still-running run — same
 *  field names as `ledgerRow` where they apply, plus `status: "running"` and
 *  no `verdict`/`rangeSha`/`manifestSha` (not resolved yet). */
function runningRow(run: ReviewRun): Record<string, unknown> {
  return {
    runId: run.runId,
    status: "running" as const,
    ...(run.reviewId ? { reviewId: run.reviewId } : {}),
    ...(run.binding ? { binding: run.binding } : {}),
    ...(run.repoRemote ? { repoRemote: run.repoRemote } : {}),
    ...(run.baseSha ? { baseSha: run.baseSha } : {}),
    ...(run.headSha ? { headSha: run.headSha } : {}),
    createdAt: run.startedAt,
    ...(run.repoRoot ? { cwd: run.repoRoot } : {}),
    ...(run.requesterSessionId ? { requester: { sessionId: run.requesterSessionId } } : {}),
    lanes: run.lanes.map((l) => ({ id: l.id, status: l.status, blocking: l.blocking })),
  }
}

const prRefSchema = z
  .object({
    provider: z.literal("github"),
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/name"),
    number: z.number().int().positive(),
    url: z.string().url(),
  })
  .strict()

/** Resolve `<base>..<head>` / 64-hex to a rangeSha (refs need `root`). */
async function resolveRangeSha(range: string, root: string | undefined): Promise<string> {
  if (HEX64.test(range)) return range
  const m = range.match(/^(.+?)\.\.(.+)$/)
  if (!m) throw new Error("`range` must be `<base>..<head>` or a 64-hex rangeSha")
  const [base, head] = [m[1]!, m[2]!]
  const isSha = (s: string) => /^[0-9a-f]{40}$/.test(s)
  const baseSha = root ? await revParse(root, base) : base
  const headSha = root ? await revParse(root, head) : head
  if (!isSha(baseSha) || !isSha(headSha)) {
    throw new Error("refs in `range` need `cwd` to resolve; otherwise pass full 40-hex shas")
  }
  return computeRangeSha({ baseSha, headSha })
}

/** Summary of an attestation for the `review_pr` view. */
const attestationSummary = (entry: LedgerEntry): Record<string, unknown> => {
  const { lanes: _lanes, ...rest } = ledgerRow(entry)
  return rest
}

/** The newest ledger entry whose annotations (or attestation) link `pr`. */
async function findByPr(ledger: ReviewLedger, pr: { repo: string; number: number }): Promise<LedgerEntry | undefined> {
  for (const e of (await ledger.list()).filter((x) => isRemoteOf(x.attestation.target.repoRemote, pr.repo))) {
    const linked = (await ledger.getAnnotations(ledgerKeyOf(e.attestation))).pr ?? e.attestation.pr
    if (linked && linked.repo === pr.repo && linked.number === pr.number) return e
  }
  return undefined
}

const HEX64 = /^[0-9a-f]{64}$/

export interface ReviewLedgerQuery {
  cwd?: string
  repoRemote?: string
  range?: string
  binding?: string
  requesterSessionId?: string
  subtree?: boolean
  includeRunning?: boolean
  limit?: number
}

/**
 * The `review_ledger` tool's body, factored out so a non-MCP caller (the
 * `agentproto_reviews` builtin panel's initial snapshot, builtin-apps.ts)
 * gets the EXACT same rows the tool itself returns — one implementation,
 * not a second one that could drift. Throws on a bad `range`; the MCP
 * handler above turns that into `errorContent`, a direct caller decides its
 * own error handling.
 */
export async function reviewLedgerView(
  runner: ReviewRunner,
  input: ReviewLedgerQuery,
  opts: { resolveSubtree?: (sessionId: string) => readonly string[] } = {},
): Promise<{ total: number; attestations: Record<string, unknown>[] }> {
  let repoRemote = input.repoRemote
  let root: string | undefined
  if (input.cwd) {
    const repo = await resolveRepo(input.cwd)
    root = repo.root
    repoRemote ??= repo.repoRemote
  }
  let rangeSha: string | undefined
  if (input.range !== undefined) {
    rangeSha = await resolveRangeSha(input.range, root)
  }
  const requesterSessionIds = input.requesterSessionId
    ? input.subtree && opts.resolveSubtree
      ? [...opts.resolveSubtree(input.requesterSessionId)]
      : [input.requesterSessionId]
    : undefined
  const entries = await runner.ledger.list({
    ...(repoRemote !== undefined ? { repoRemote } : {}),
    ...(rangeSha !== undefined ? { rangeSha } : {}),
    ...(input.binding !== undefined ? { binding: input.binding } : {}),
    ...(requesterSessionIds ? { requesterSessionIds } : {}),
  })
  let runningRows: Record<string, unknown>[] = []
  if (input.includeRunning) {
    const requesterSet = requesterSessionIds ? new Set(requesterSessionIds) : undefined
    runningRows = runner
      .list()
      .filter((r) => r.status === "running")
      .filter((r) => repoRemote === undefined || r.repoRemote === repoRemote)
      .filter((r) => input.binding === undefined || r.binding === input.binding)
      .filter((r) => !requesterSet || (r.requesterSessionId !== undefined && requesterSet.has(r.requesterSessionId)))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(runningRow)
  }
  const limit = input.limit ?? 50
  const settledRows = await Promise.all(
    entries
      .slice(0, Math.max(limit - runningRows.length, 0))
      .map(async (e) => ledgerRow(e, await runner.ledger.getAnnotations(ledgerKeyOf(e.attestation)))),
  )
  const rows = [...runningRows, ...settledRows].slice(0, limit)
  return { total: entries.length + runningRows.length, attestations: rows }
}

export interface RegisterReviewToolsOptions {
  runner: ReviewRunner
  /** The calling session (from `?callerSessionId=`) — agent-lane reviewer
   *  sessions nest under it, and it is the default requester. */
  callerSessionId?: string
  /** `gh` runner for `review_pr` — injectable for tests. Default: the real
   *  `gh` on the daemon's PATH. */
  gh?: GhRunner
  /** Resolve a session id to its subtree (itself + every session it
   *  transitively spawned) — backs `review_ledger({requesterSessionId,
   *  subtree: true})`. Omitted ⇒ `subtree` is ignored (scoped to the exact
   *  id only), so a caller without sessions-registry access still works,
   *  just without the subtree expansion. */
  resolveSubtree?: (sessionId: string) => readonly string[]
}

export function registerReviewTools(server: McpServer, opts: RegisterReviewToolsOptions): void {
  const { runner, callerSessionId, resolveSubtree } = opts
  const gh = opts.gh ?? execGh

  // ── review_run ────────────────────────────────────────────────
  server.tool(
    "review_run",
    "Run a REVIEW.md review over a git range and return its attestation. Resolves the " +
      "range (default: merge-base(<target.base>, HEAD)..HEAD), runs the binding's prepare " +
      "steps, FREEZES the range, runs the binding's check lanes in parallel (command lanes " +
      "as subprocesses, agent lanes as child reviewer sessions under a harness preset), and " +
      "folds a verdict: pass | block | incomplete (a lane that timed out or couldn't run is " +
      "never a pass). The attestation is written to the daemon's review ledger keyed by " +
      "(repoRemote, manifestSha, binding, rangeSha); a prior clean pass/block for the same key " +
      "is returned with `cached: true` unless `nocache`. Blocks until done by default; pass " +
      "`wait: false` for a runId to poll with `review_status`.",
    {
      cwd: z.string().describe("Any directory inside the git repo to review."),
      manifestPath: z
        .string()
        .optional()
        .describe("REVIEW.md path, absolute or relative to `cwd`. Default: <repo root>/REVIEW.md."),
      binding: z.string().optional().describe("Binding to run (e.g. local, ci). Default: the sole binding, or `default`."),
      base: z.string().optional().describe("Range base ref/sha. Default: merge-base(<manifest target.base>, HEAD)."),
      head: z.string().optional().describe("Range head ref/sha. Default: HEAD, resolved after the prepare phase."),
      nocache: z.boolean().optional().describe("Ignore a cached ledger verdict and re-run. Default false. Implies compose:false."),
      compose: z
        .boolean()
        .optional()
        .describe(
          "Let an agent lane reuse a prior passing attestation and review only the delta on top of it (attestation " +
            "composition — see LaneResult.composedFrom). Default true. Command lanes are never composed. Ignored " +
            "(false) when `nocache` is set.",
        ),
      wait: z.boolean().optional().describe("Block until the review finishes (default true). false ⇒ return a runId immediately."),
      requesterSessionId: z
        .string()
        .optional()
        .describe("Session recorded as attestation.requester.sessionId. Default: the calling session."),
      pr: prRefSchema
        .optional()
        .describe(
          "The PR this range is reviewed for ({provider:'github', repo:'owner/name', number, url}) — recorded in the " +
            "attestation and as the ledger entry's PR link. Pass it when you know it (a CI binding).",
        ),
      supersede: z
        .boolean()
        .optional()
        .describe(
          "Cancel in-flight reviews of the same repo + binding + base whose head DIFFERS (an older push). Cancelled " +
            "runs write no verdict. Default false — gates that re-run on every push should pass true.",
        ),
    },
    async (input) => {
      try {
        const run = runner.start({
          cwd: input.cwd,
          ...(input.manifestPath !== undefined ? { manifestPath: input.manifestPath } : {}),
          ...(input.binding !== undefined ? { binding: input.binding } : {}),
          ...(input.base !== undefined ? { base: input.base } : {}),
          ...(input.head !== undefined ? { head: input.head } : {}),
          ...(input.nocache ? { nocache: true } : {}),
          ...(input.compose !== undefined ? { compose: input.compose } : {}),
          ...(callerSessionId ? { parentSessionId: callerSessionId } : {}),
          ...(input.requesterSessionId !== undefined ? { requesterSessionId: input.requesterSessionId } : {}),
          ...(input.pr ? { pr: input.pr as ReviewPrRef } : {}),
          ...(input.supersede ? { supersede: true } : {}),
        })
        if (input.wait === false) return jsonContent({ runId: run.runId, status: run.status })
        const finished = (await runner.wait(run.runId)) ?? run
        const view = runView(finished)
        return finished.status === "failed" ? { ...jsonContent(view), isError: true as const } : jsonContent(view)
      } catch (err) {
        return errorContent(`review_run failed: ${errMessage(err)}`)
      }
    },
  )

  // ── review_status ─────────────────────────────────────────────
  server.tool(
    "review_status",
    "Poll a review started with `review_run` (`wait: false`). While running, reports the " +
      "lanes settled so far; once done, the verdict and full attestation. Falls back to the " +
      "ledger for a run that finished before a daemon restart.",
    {
      runId: z.string().describe("Run id returned by `review_run`."),
    },
    async ({ runId }) => {
      const run = await runner.status(runId)
      if (!run) return errorContent(`review run '${runId}' not found`)
      return jsonContent(runView(run))
    },
  )

  // ── review_cancel ─────────────────────────────────────────────
  server.tool(
    "review_cancel",
    "Cancel a running review. Lanes not yet started are skipped; running command lanes are " +
      "killed and running reviewer sessions are killed through the session lifecycle. The " +
      "run ends `cancelled` and writes NO verdict to the ledger.",
    {
      runId: z.string().describe("Run id to cancel."),
    },
    async ({ runId }) => {
      const cancelled = runner.cancel(runId)
      const run = await runner.status(runId)
      return jsonContent({ runId, cancelled, status: run?.status ?? "not_found" })
    },
  )

  // ── review_ledger ─────────────────────────────────────────────
  server.tool(
    "review_ledger",
    "List review attestations recorded in the daemon's ledger (~/.agentproto/reviews), " +
      "newest first. Filter by repo (`cwd` resolves its remote, or pass `repoRemote`), by " +
      "`range` (`<base>..<head>` refs/shas — refs need `cwd` — or a 64-hex rangeSha), by " +
      "`binding`, and by `requesterSessionId` (the session that asked for the review — pass " +
      "`subtree: true` to also include reviews requested by any session it transitively " +
      "spawned). `includeRunning: true` prepends in-flight runs — rows with `status: " +
      "\"running\"` and the lanes settled so far — ahead of the settled ones. Rows are " +
      "compact; use `review_export` for a full attestation.",
    {
      cwd: z.string().optional().describe("A directory inside the repo — scopes to its remote and resolves `range` refs."),
      repoRemote: z.string().optional().describe("Normalized repo remote (e.g. github.com/agentproto/ts)."),
      range: z.string().optional().describe("`<base>..<head>` or a 64-hex rangeSha."),
      binding: z.string().optional().describe("Keep only this binding."),
      requesterSessionId: z
        .string()
        .optional()
        .describe("Keep only reviews requested by this session (attestation.requester.sessionId)."),
      subtree: z
        .boolean()
        .optional()
        .describe(
          "With `requesterSessionId`, also include reviews requested by any session it " +
            "transitively spawned. Ignored without `requesterSessionId`. Default false.",
        ),
      includeRunning: z
        .boolean()
        .optional()
        .describe("Also list in-flight runs (this daemon process only) ahead of the settled ones. Default false."),
      limit: z.number().int().positive().max(500).optional().describe("Max rows (default 50)."),
    },
    async (input) => {
      try {
        return jsonContent(await reviewLedgerView(runner, input, { resolveSubtree }))
      } catch (err) {
        return errorContent(`review_ledger failed: ${errMessage(err)}`)
      }
    },
  )

  // ── review_export ─────────────────────────────────────────────
  server.tool(
    "review_export",
    "Write one attestation from the ledger as a standalone JSON file — self-contained " +
      "(manifestSha, binding, repoRemote + base/head shas, rangeSha, per-lane results, " +
      "verdict, attestor) so a CI verifier can recompute the manifest and range hashes and " +
      "trust the verdict. Select by `runId`, or by `repoRemote` + `rangeSha` (+ `binding` " +
      "when several match). `outPath` defaults to the manifest's `verdict.exportDir`.",
    {
      runId: z.string().optional().describe("Run id (from review_run / review_ledger)."),
      repoRemote: z.string().optional().describe("Normalized repo remote — with `rangeSha`."),
      rangeSha: z.string().optional().describe("64-hex rangeSha — with `repoRemote`."),
      binding: z.string().optional().describe("Disambiguate a repoRemote+rangeSha selection."),
      outPath: z
        .string()
        .optional()
        .describe("Destination file. Absolute, or relative to `cwd` (else to the reviewed repo root)."),
      cwd: z.string().optional().describe("Base directory for a relative `outPath`."),
    },
    async (input) => {
      try {
        let entry: LedgerEntry | undefined
        let attestation: Attestation | undefined
        if (input.runId) {
          const run = await runner.status(input.runId)
          attestation = run?.attestation
          if (attestation) entry = await runner.ledger.findByRunId(attestation.runId)
          if (!attestation) return errorContent(`review_export: no attestation for run '${input.runId}' (not found or not finished)`)
        } else if (input.repoRemote && input.rangeSha) {
          const matches = await runner.ledger.list({
            repoRemote: input.repoRemote,
            rangeSha: input.rangeSha,
            ...(input.binding !== undefined ? { binding: input.binding } : {}),
          })
          if (matches.length === 0) return errorContent("review_export: no attestation matches that repoRemote + rangeSha")
          if (matches.length > 1) {
            return errorContent(
              `review_export: ${matches.length} attestations match — pass \`binding\` or a \`runId\` (${matches
                .map((m) => `${m.attestation.runId} [${m.attestation.binding}]`)
                .join(", ")})`,
            )
          }
          entry = matches[0]!
          attestation = entry.attestation
        } else {
          return errorContent("review_export: pass `runId`, or `repoRemote` + `rangeSha`")
        }

        let outPath: string
        if (input.outPath) {
          const base = input.cwd ?? entry?.host.repoRoot
          if (!isAbsolute(input.outPath) && !base) {
            return errorContent("review_export: relative `outPath` needs `cwd`")
          }
          outPath = isAbsolute(input.outPath) ? input.outPath : resolve(base!, input.outPath)
        } else if (entry?.host.exportDir) {
          outPath = join(
            entry.host.exportDir,
            `${attestation.reviewId}-${attestation.binding}-${attestation.target.headSha.slice(0, 12)}.json`,
          )
        } else {
          return errorContent("review_export: `outPath` is required (the manifest declares no `verdict.exportDir`)")
        }
        await mkdir(dirname(outPath), { recursive: true })
        await writeFile(outPath, `${JSON.stringify(attestation, null, 2)}\n`, "utf8")
        return jsonContent({ path: outPath, runId: attestation.runId, verdict: attestation.verdict })
      } catch (err) {
        return errorContent(`review_export failed: ${errMessage(err)}`)
      }
    },
  )

  // ── review_pr ─────────────────────────────────────────────────
  server.tool(
    "review_pr",
    "Follow a recorded review to its GitHub pull request. Selects a ledger entry by `runId`, " +
      "`rangeSha`, `range` (+ `cwd`), `cwd` alone (the newest entry whose head is the checkout's " +
      "HEAD), or `prUrl` (an entry already linked to that PR, else one whose head is the PR's " +
      "head). With no PR link yet it resolves headSha → PR through the daemon host's `gh` " +
      "(`repos/{owner}/{repo}/commits/{sha}/pulls`) and records the link. Then it fetches the PR's " +
      "state + reviews (+ check runs), appends that snapshot to the entry's annotations (never to " +
      "the attestation), and returns attestation summary + pr + latest status. `gh` missing, " +
      "offline, or no PR found ⇒ `ok: false` with a structured `error: {code, message}`.",
    {
      runId: z.string().optional().describe("Run id (from review_run / review_ledger)."),
      rangeSha: z.string().optional().describe("64-hex rangeSha (scoped to `cwd`'s repo when `cwd` is given)."),
      range: z.string().optional().describe("`<base>..<head>` (refs need `cwd`) or a 64-hex rangeSha."),
      cwd: z.string().optional().describe("A directory inside the reviewed repo."),
      prUrl: z.string().optional().describe("https://github.com/<owner>/<repo>/pull/<n>"),
    },
    async (input) => {
      try {
        let entry: LedgerEntry | undefined
        let requestedPr: ReviewPrRef | undefined
        let repoRemote: string | undefined
        let root: string | undefined
        if (input.cwd) {
          const repo = await resolveRepo(input.cwd)
          root = repo.root
          repoRemote = repo.repoRemote
        }
        const scoped = (f: { rangeSha?: string }) =>
          runner.ledger.list({ ...f, ...(repoRemote !== undefined ? { repoRemote } : {}) })

        if (input.runId) {
          const run = await runner.status(input.runId)
          if (run?.attestation) entry = await runner.ledger.get(ledgerKeyOf(run.attestation))
          if (!entry) return errorContent(`review_pr: no recorded attestation for run '${input.runId}'`)
        } else if (input.rangeSha !== undefined || input.range !== undefined) {
          const rangeSha = await resolveRangeSha((input.rangeSha ?? input.range)!, root)
          entry = (await scoped({ rangeSha }))[0]
          if (!entry) return errorContent("review_pr: no recorded attestation for that range")
        } else if (input.prUrl) {
          const parsed = parsePrUrl(input.prUrl)
          if (!parsed) return errorContent("review_pr: `prUrl` must look like https://github.com/<owner>/<repo>/pull/<n>")
          requestedPr = prRef(parsed.repo, parsed.number)
          entry = await findByPr(runner.ledger, parsed)
          if (!entry) {
            let head: string | undefined
            try {
              head = await prHeadSha(gh, parsed.repo, parsed.number)
            } catch (err) {
              const e = toPrLookupError(err)
              return jsonContent({ ok: false, pr: requestedPr, error: { code: e.code, message: e.message } })
            }
            entry = head
              ? (await runner.ledger.list()).find(
                  (e) => isRemoteOf(e.attestation.target.repoRemote, parsed.repo) && e.attestation.target.headSha === head,
                )
              : undefined
            if (!entry) {
              return errorContent(
                `review_pr: no recorded attestation is linked to ${requestedPr.url} or reviews its head${head ? ` (${head})` : ""}`,
              )
            }
          }
        } else if (root) {
          const head = await revParse(root, "HEAD")
          entry = (await scoped({})).find((e) => e.attestation.target.headSha === head)
          if (!entry) return errorContent(`review_pr: no recorded attestation for ${root} at HEAD (${head})`)
        } else {
          return errorContent("review_pr: pass `runId`, `rangeSha`, `range` (+ `cwd`), `cwd`, or `prUrl`")
        }

        const a = entry.attestation
        const key = ledgerKeyOf(a)
        const annotations = await runner.ledger.getAnnotations(key)
        let pr = annotations.pr ?? a.pr ?? requestedPr
        let linkedVia: "annotation" | "attestation" | "prUrl" | "resolved" | undefined = annotations.pr
          ? "annotation"
          : a.pr
            ? "attestation"
            : requestedPr
              ? "prUrl"
              : undefined
        try {
          if (!pr) {
            const repo = githubRepoOf(a.target.repoRemote)
            if (!repo) {
              return jsonContent({
                ok: false,
                attestation: attestationSummary(entry),
                error: {
                  code: "unsupported_remote",
                  message: `'${a.target.repoRemote}' is not a github.com remote — review_pr only follows GitHub PRs`,
                },
              })
            }
            pr = await findPrForCommit(gh, repo, a.target.headSha)
            if (!pr) {
              return jsonContent({
                ok: false,
                attestation: attestationSummary(entry),
                error: { code: "no_pr", message: `GitHub knows no pull request containing ${a.target.headSha} in ${repo}` },
              })
            }
            linkedVia = "resolved"
          }
          const snapshot = await fetchPrStatus(gh, pr)
          const linkPr = pr
          const updated = await runner.ledger.updateAnnotations(key, (cur) =>
            withPrStatus(snapshot)(cur.pr ? cur : withPr(linkPr)(cur)),
          )
          return jsonContent({
            ok: true,
            attestation: attestationSummary(entry),
            pr: updated.pr ?? pr,
            linkedVia,
            status: snapshot,
            snapshots: updated.prStatus?.length ?? 1,
          })
        } catch (err) {
          const e = toPrLookupError(err)
          return jsonContent({
            ok: false,
            attestation: attestationSummary(entry),
            ...(pr ? { pr } : {}),
            ...(annotations.prStatus?.length ? { lastStatus: annotations.prStatus.at(-1) } : {}),
            error: { code: e.code, message: e.message },
          })
        }
      } catch (err) {
        return errorContent(`review_pr failed: ${errMessage(err)}`)
      }
    },
  )
}

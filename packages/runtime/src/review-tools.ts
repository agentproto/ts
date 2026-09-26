/**
 * MCP tools for the review primitive (`@agentproto/review`):
 *
 *   review_run     run a REVIEW.md binding over a git range → attestation
 *                  (ledger hit ⇒ the cached verdict, `cached: true`)
 *   review_status  poll a run started with `wait: false`
 *   review_cancel  cancel a running review (lane sessions are killed)
 *   review_ledger  list recorded attestations
 *   review_export  write one attestation out as a standalone JSON file
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
import { rangeSha as computeRangeSha, type Attestation } from "@agentproto/review"
import type { LedgerEntry } from "./review-ledger.js"
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
    ...(run.status === "running" ? { lanes: run.lanes.map((l) => ({ id: l.id, status: l.status })) } : {}),
    ...(run.attestation ? { attestation: run.attestation } : {}),
    ...(run.ledgerPath ? { ledgerPath: run.ledgerPath } : {}),
  }
}

/** Compact `review_ledger` row. */
function ledgerRow(a: Attestation): Record<string, unknown> {
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
    ...(a.dirty ? { dirty: true } : {}),
    lanes: a.lanes.map((l) => ({ id: l.id, status: l.status, blocking: l.blocking })),
  }
}

const HEX64 = /^[0-9a-f]{64}$/

export interface RegisterReviewToolsOptions {
  runner: ReviewRunner
  /** The calling session (from `?callerSessionId=`) — agent-lane reviewer
   *  sessions nest under it. */
  callerSessionId?: string
}

export function registerReviewTools(server: McpServer, opts: RegisterReviewToolsOptions): void {
  const { runner, callerSessionId } = opts

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
      nocache: z.boolean().optional().describe("Ignore a cached ledger verdict and re-run. Default false."),
      wait: z.boolean().optional().describe("Block until the review finishes (default true). false ⇒ return a runId immediately."),
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
          ...(callerSessionId ? { parentSessionId: callerSessionId } : {}),
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
      "resulting verdict is `incomplete`.",
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
      "`range` (`<base>..<head>` refs/shas — refs need `cwd` — or a 64-hex rangeSha), and by " +
      "`binding`. Rows are compact; use `review_export` for a full attestation.",
    {
      cwd: z.string().optional().describe("A directory inside the repo — scopes to its remote and resolves `range` refs."),
      repoRemote: z.string().optional().describe("Normalized repo remote (e.g. github.com/agentproto/ts)."),
      range: z.string().optional().describe("`<base>..<head>` or a 64-hex rangeSha."),
      binding: z.string().optional().describe("Keep only this binding."),
      limit: z.number().int().positive().max(500).optional().describe("Max rows (default 50)."),
    },
    async (input) => {
      try {
        let repoRemote = input.repoRemote
        let root: string | undefined
        if (input.cwd) {
          const repo = await resolveRepo(input.cwd)
          root = repo.root
          repoRemote ??= repo.repoRemote
        }
        let rangeSha: string | undefined
        if (input.range !== undefined) {
          if (HEX64.test(input.range)) {
            rangeSha = input.range
          } else {
            const m = input.range.match(/^(.+?)\.\.(.+)$/)
            if (!m) return errorContent("review_ledger: `range` must be `<base>..<head>` or a 64-hex rangeSha")
            const [base, head] = [m[1]!, m[2]!]
            const isSha = (s: string) => /^[0-9a-f]{40}$/.test(s)
            const baseSha = root ? await revParse(root, base) : base
            const headSha = root ? await revParse(root, head) : head
            if (!isSha(baseSha) || !isSha(headSha)) {
              return errorContent("review_ledger: refs in `range` need `cwd` to resolve; otherwise pass full 40-hex shas")
            }
            rangeSha = computeRangeSha({ baseSha, headSha })
          }
        }
        const entries = await runner.ledger.list({
          ...(repoRemote !== undefined ? { repoRemote } : {}),
          ...(rangeSha !== undefined ? { rangeSha } : {}),
          ...(input.binding !== undefined ? { binding: input.binding } : {}),
        })
        const limit = input.limit ?? 50
        return jsonContent({
          total: entries.length,
          attestations: entries.slice(0, limit).map((e) => ledgerRow(e.attestation)),
        })
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
}

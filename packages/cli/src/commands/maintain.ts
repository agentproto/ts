/**
 * `agentproto maintain [--repo <dir>] [--apply-merged] [--wait] [--json]`
 *
 * Convenience shortcut over `agentproto workflow run-file` for the built-in
 * `repo-maintenance` app's `maintain` workflow (`@agentproto/apps`'s
 * `repo-maintenance/.agentproto/workflows/maintain/WORKFLOW.md`): plan
 * worktree_gc + branch_gc, fan a reviewer agent out over every unmerged
 * branch candidate, verify every candidate got a verdict, optionally apply
 * (reclaim-class only) when `--apply-merged` is set, and report. Needs a
 * running daemon — the workflow's `review` step spawns real agent sessions.
 *
 * Resolves the bundled WORKFLOW.md via `@agentproto/apps`'s own package
 * resolution (not a monorepo-relative path) so this works the same whether
 * `agentproto` is running from this checkout or a published npm install.
 */
import { parseArgs } from "node:util"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { mcpToolCall, withDaemon } from "./workflow.js"
import { repoRootOf } from "./worktree.js"
import { httpGetJson } from "./_daemon-helpers.js"

const USAGE = `agentproto maintain — plan/review (and optionally apply) branch + worktree gc for a repo

Usage:
  agentproto maintain [--repo <dir>] [--apply-merged] [--wait] [--json]
  agentproto maintain --help

  --repo <dir>     Any dir inside the repo. Default: cwd's git toplevel.
  --apply-merged   After review, apply branch_gc (reclaim-class only,
                   includeReviewed false) and worktree_gc. Default: dry run
                   (plan + review only, nothing is deleted).
  --wait           Block until the run ends, then print its markdown report
                   (exit 0 when done, 1 when it failed/was cancelled).
  --json           Print the raw workflow_run_file reply (with --wait: the
                   finished run record, whose \`output\` holds report + gaps).

Runs the built-in repo-maintenance app's \`maintain\` workflow via the
daemon's workflow_run_file — needs a running daemon (\`agentproto serve\`),
since the review step spawns real agent sessions. Poll the run with
\`agentproto workflow status <runId>\`, or pass --wait. The report is kept
on the run record (\`output.report\`) after the run ends.

Examples:
  agentproto maintain --repo ~/code/my-app
  agentproto maintain --repo ~/code/my-app --apply-merged
  agentproto maintain --wait
`

/** Resolve the bundled repo-maintenance app's dir + its maintain WORKFLOW.md
 *  through @agentproto/apps's own package resolution — works whether this
 *  CLI runs from the monorepo or a published npm install, as long as
 *  @agentproto/apps ships alongside it. */
function resolveRepoMaintenanceApp(): { appDir: string; workflowPath: string } {
  const require = createRequire(import.meta.url)
  const appsPackageJson = require.resolve("@agentproto/apps/package.json")
  const appDir = join(dirname(appsPackageJson), "repo-maintenance")
  return { appDir, workflowPath: join(appDir, ".agentproto", "workflows", "maintain", "WORKFLOW.md") }
}

export async function runMaintain(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      repo: { type: "string" },
      "apply-merged": { type: "boolean" },
      wait: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  })

  const repoRoot = repoRootOf(resolve(values.repo ?? process.cwd()))
  if (!repoRoot) {
    process.stderr.write("agentproto maintain: not inside a git repository.\n")
    return 2
  }

  let appDir: string
  let workflowPath: string
  try {
    ;({ appDir, workflowPath } = resolveRepoMaintenanceApp())
  } catch (err) {
    process.stderr.write(
      `agentproto maintain: cannot locate the bundled repo-maintenance app — is @agentproto/apps installed? ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
    return 1
  }

  const daemon = await withDaemon("agentproto maintain")
  if (!daemon.ok) return daemon.code

  // The `review` step's `kind:"agent"` step resolves `agent.ref` against the
  // daemon's installed-app registry (`resolveAgentRefsForWorkflow`) — a bare
  // `workflow_run_file` call with no owning app fails compilation ("no agent
  // refs are configured"). `app_install` upserts, so installing on every run
  // is cheap and keeps this shortcut self-sufficient (no separate manual
  // `agentproto app install` step).
  try {
    await mcpToolCall(daemon.endpoint, "app_install", { dir: appDir })
  } catch (err) {
    process.stderr.write(
      `agentproto maintain: failed to install the repo-maintenance app: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
    return 1
  }

  let result: Record<string, unknown>
  try {
    result = (await mcpToolCall(daemon.endpoint, "workflow_run_file", {
      path: workflowPath,
      input: { repoRoot, applyMerged: values["apply-merged"] === true },
    })) as Record<string, unknown>
  } catch (err) {
    process.stderr.write(`agentproto maintain: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  if (result["error"] !== undefined) {
    process.stderr.write(`agentproto maintain: ${String(result["error"])}\n`)
    return 1
  }
  if (values.wait) {
    const runId = String(result["runId"])
    process.stderr.write(`agentproto maintain: waiting for run ${runId}…\n`)
    let run: MaintainRunShape
    try {
      run = await waitForRunEnd(() =>
        httpGetJson<MaintainRunShape>(`${daemon.endpoint.url}/workflows/${encodeURIComponent(runId)}`),
      )
    } catch (err) {
      process.stderr.write(`agentproto maintain: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    if (values.json) {
      process.stdout.write(JSON.stringify(run, null, 2) + "\n")
    } else {
      const report = run.output?.report
      if (typeof report === "string") process.stdout.write(report + "\n")
      if (run.status !== "done") {
        process.stderr.write(
          `agentproto maintain: run ${runId} ended ${run.status}${run.error ? ` — ${run.error}` : ""}\n`,
        )
      }
    }
    return run.status === "done" ? 0 : 1
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }
  process.stdout.write(
    `✓ Started repo maintenance for ${repoRoot} — run ${String(result["runId"])} (${String(result["status"])}).\n` +
      `  Poll: agentproto workflow status ${String(result["runId"])}\n`,
  )
  return 0
}

/** The slice of a `GET /workflows/:id` run record `--wait` reads. */
export interface MaintainRunShape {
  runId: string
  status: string
  error?: string
  output?: { report?: unknown; gaps?: unknown }
}

/** A run status past which polling is pointless: finished, or parked on a
 *  human (the maintain workflow has no approval/suspend step, but a parked
 *  run would otherwise block `--wait` forever). */
const RUN_END_STATUSES = new Set(["done", "failed", "cancelled", "awaiting-approval", "awaiting-input"])

/** Poll `fetchRun` until the run reaches an end status; returns that record. */
export async function waitForRunEnd(
  fetchRun: () => Promise<MaintainRunShape>,
  opts: { intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MaintainRunShape> {
  const intervalMs = opts.intervalMs ?? 5_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  for (;;) {
    const run = await fetchRun()
    if (RUN_END_STATUSES.has(run.status)) return run
    await sleep(intervalMs)
  }
}

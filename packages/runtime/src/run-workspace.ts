/**
 * AIP-58 §4 Run workspace — the host-owned per-run directory layout:
 *
 *   <runsRoot>/<runId>/
 *     inputs/     — reserved for staged `inputsFiles` (AIP-16); not yet
 *                   populated by this host — a follow-up, not P4's scope
 *     artifacts/  — copies of every entry in Run.artifacts[]
 *     scratch/    — the AIP-16 fsRoot; exposed to steps as `$run.workspace` /
 *                   `_workflowFsRoot`
 *
 * **Two runs MUST NEVER share a workspace** (§4) — this is why the root is
 * `<runsRoot>/<runId>/`, keyed ONLY by the host-generated, unique `runId`,
 * never by a caller-supplied `cacheKey`. Cache/replay continuity across
 * SEPARATE runs (the same logical work, re-invoked) is instead handled by
 * `@agentproto/workflow-runtime`'s `kind: "artifact"` step, which relocates
 * (copies) a cache-hit's file from its ORIGINAL run's `artifacts/` into the
 * CURRENT run's own — see that package's `run-workflow.ts` and this
 * package's `run-workspace.test.ts` for the exact mechanics. Two runs
 * sharing a directory would violate this section's invariant even when the
 * intent is "replay the same work" — replay still gets its own workspace
 * (AIP-58 §6 Journal: `run.replay` "creates a new run... a sibling of the
 * original, not a mutation of it").
 *
 * Retention/cleanup (deliberately NOT implemented here — AIP-58 §4 specifies
 * no retention rule, same posture AIP-46 §State partitioning takes for
 * transcripts): `scratch/` MAY be discarded once a run reaches a terminal
 * state; `inputs/` and `artifacts/` SHOULD be retained per a host's own
 * policy. A future sweep would live alongside `idle-reaper.ts` /
 * `crash-reaper.ts` — a daemon-owned interval that walks `<runsRoot>/*`,
 * skips any run whose `status` isn't terminal (read via `workflow-runner.ts`'s
 * persisted `WorkflowRun`, not a directory scan alone — a `scratch/` for a
 * `running` run must never be swept out from under it), and removes
 * `scratch/` (optionally `artifacts/` too, past some retention window) for
 * the rest. No such sweep exists yet; this comment is the pointer for
 * whoever adds it.
 */

import { join } from "node:path"
import { mkdirSync } from "node:fs"

export interface RunWorkspacePaths {
  /** `<runsRoot>/<runId>/` — the whole allocation; not itself written to. */
  readonly root: string
  /** `<root>/inputs/` — reserved for staged `inputsFiles` (not yet used). */
  readonly inputsDir: string
  /** `<root>/artifacts/` — one file per `Run.artifacts[]` entry, named by
   *  its (sanitized) key. */
  readonly artifactsDir: string
  /** `<root>/scratch/` — the AIP-16 fsRoot; `$run.workspace` / `{{run.workspace}}`. */
  readonly scratch: string
}

export function runWorkspacePaths(runsRoot: string, runId: string): RunWorkspacePaths {
  const root = join(runsRoot, runId)
  return {
    root,
    inputsDir: join(root, "inputs"),
    artifactsDir: join(root, "artifacts"),
    scratch: join(root, "scratch"),
  }
}

/** Create the three subdirectories (idempotent — `mkdir -p`) and return the
 *  resolved paths. Best-effort is NOT appropriate here (unlike most
 *  filesystem writes elsewhere in this package): a run whose workspace
 *  failed to allocate must not silently proceed as if it had one. */
export function ensureRunWorkspace(runsRoot: string, runId: string): RunWorkspacePaths {
  const paths = runWorkspacePaths(runsRoot, runId)
  mkdirSync(paths.inputsDir, { recursive: true })
  mkdirSync(paths.artifactsDir, { recursive: true })
  mkdirSync(paths.scratch, { recursive: true })
  return paths
}

/** Filesystem-safe filename for an artifact key — MUST exactly match
 *  `@agentproto/workflow-runtime`'s own `sanitizeArtifactKey` (run-workflow.ts),
 *  since both sides name the same file under `artifactsDir` independently
 *  (the runtime writes it; this package reads it back for `publish`/
 *  `readArtifact`). Duplicated rather than shared across the package
 *  boundary for one two-line pure function. */
export function sanitizeArtifactKey(key: string): string {
  const cleaned = key.replace(/[^a-zA-Z0-9._-]/g, "_")
  return cleaned.length > 0 ? cleaned : "artifact"
}

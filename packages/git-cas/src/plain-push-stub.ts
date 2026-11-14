/**
 * Test-only negative control: the naive helper this package replaces. It
 * runs a plain `git push` and reports `pushed` on exit 0, `rejected_other`
 * otherwise, ignoring `expected`. `GIT_CAS_IMPL=plain` points the casPush
 * suite at it; every casPush case is written to fail against it.
 */
import { execFileSync } from "node:child_process"

import type { CasPushInput, CasPushResult } from "./index.js"

export async function plainPush(i: CasPushInput): Promise<CasPushResult> {
  const remote = i.remote ?? "origin"
  const ref = `refs/heads/${i.branch}`
  const tip = execFileSync("git", ["rev-parse", i.localRef ?? "HEAD"], {
    cwd: i.cwd,
    encoding: "utf8",
  }).trim()
  const before =
    execFileSync("git", ["ls-remote", remote, ref], {
      cwd: i.cwd,
      encoding: "utf8",
    }).split("\t")[0] || null
  try {
    execFileSync("git", ["push", remote, `${tip}:${ref}`], {
      cwd: i.cwd,
      stdio: "pipe",
    })
    return { outcome: "pushed", branch: i.branch, from: before, to: tip }
  } catch (e) {
    return {
      outcome: "rejected_other",
      branch: i.branch,
      reason: "unknown",
      detail: String((e as Error).message),
    }
  }
}

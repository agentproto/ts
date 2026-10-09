import os from "node:os"

/**
 * Cap every vitest pool on the machine so `pnpm -r test` cannot saturate the
 * host (24 processes / 275% CPU observed while the machine was swapping).
 * `VITEST_MAX_WORKERS` overrides; otherwise 1/4 of the available cores,
 * floor 1. Consumed via `poolOptions.threads.maxThreads` and
 * `poolOptions.forks.maxForks` (vitest 3) in each package's vitest.config.ts.
 */
export function maxWorkers(): number {
  const raw = process.env.VITEST_MAX_WORKERS
  if (raw) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
    throw new Error(`VITEST_MAX_WORKERS must be a positive integer, got "${raw}"`)
  }
  return Math.max(1, Math.floor(os.availableParallelism() / 4))
}

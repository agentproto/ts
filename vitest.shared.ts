import os from "os"

/**
 * Maximum number of vitest workers.
 * Uses the VITEST_MAX_WORKERS env var when set,
 * otherwise falls back to available parallelism divided by 4
 * (leaving room for the host process and other workers).
 */
export const VITEST_MAX_WORKERS: number = (() => {
  const env = process.env.VITEST_MAX_WORKERS
  if (env !== undefined) {
    return Math.max(1, Number(env))
  }
  return Math.max(1, Math.floor(os.availableParallelism() / 4))
})()

export default VITEST_MAX_WORKERS
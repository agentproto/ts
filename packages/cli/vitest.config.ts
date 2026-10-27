import { defineConfig } from "vitest/config"

/**
 * The worker pool must be `forks`, not threads, for `src/registry/resolve.ts`:
 * that module re-`import()`s adapter dist files on every call with an mtime
 * cache-buster (so a running daemon picks up rebuilds). A native Node ESM
 * cache is keyed by full URL including the query, which is exactly what the
 * cache-buster leans on. Conventional thread pools share one loader whose
 * module graph is keyed by FILE path rather than URL, so the cache-buster
 * silently no-ops and stale (successfully-imported-before) modules keep
 * resolving (compare `withMutatedDist("truncate")` in
 * src/__tests__/resolve.test.ts passes on old code purely because of that
 * runner cache, not the fix. A fork per test file runs modules through the
 * same native loader semantics the daemon does, so the cache-buster works.
 */
export default defineConfig({
  test: {
    pool: "forks",
  },
})

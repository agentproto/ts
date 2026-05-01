/**
 * Per-path in-process lock — serializes operations against a given absolute
 * path so concurrent callers cannot interleave a read-modify-write window.
 *
 * Implementation: one Promise chain per path, kept in a module-level Map.
 * Each operation `.then`s onto the chain; `await withPathLock(p, fn)` resolves
 * only after every prior locked operation against `p` has completed.
 *
 * Scope: in-process only. Concurrent governance writers across multiple
 * processes (same machine, multiple containers, multi-replica deploys) need
 * an external lock — `proper-lockfile`, an advisory DB lock, or moving the
 * audit log into a transactional store. Out of scope for v0.1; the README
 * documents this trust boundary.
 *
 * Why we lock at all: the audit-log append is a read-tail → compute-chain
 * → append sequence. Two concurrent appends without a lock both see the
 * same tail, both compute the same prevSignature, and the second append's
 * chain expectation no longer matches reality — the chain is silently
 * corrupted. Same race exists for the pending-signatures index (a
 * read-modify-write of a single JSON file).
 */

const chains = new Map<string, Promise<unknown>>()

export async function withPathLock<T>(
  absPath: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = chains.get(absPath) ?? Promise.resolve()
  const next = prev.then(
    () => fn(),
    () => fn()
  )
  // Store a swallowed copy so a rejected operation doesn't poison the chain.
  chains.set(
    absPath,
    next.catch(() => undefined)
  )
  return next
}

/** Test-only — drop all lock state. Never call from production code. */
export function _resetPathLocksForTest(): void {
  chains.clear()
}

/**
 * `items.map(fn)` with at most `limit` calls in flight, results in input
 * order. The first rejection stops dispatching new work and is rethrown once
 * the in-flight calls settle.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let next = 0
  let failure: { error: unknown } | null = null
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (!failure) {
        const index = next++
        if (index >= items.length) return
        try {
          results[index] = await fn(items[index] as T, index)
        } catch (error) {
          failure ??= { error }
        }
      }
    }),
  )
  if (failure) throw (failure as { error: unknown }).error
  return results
}

/** How recently the same `(target, key)` must have been seen to count as a
 *  repeat. */
export const REPEAT_WINDOW_MS = 10 * 60 * 1000

/** Default bound on the recent-key map. */
export const DEFAULT_RECENT_KEYS_CAP = 1000

function mapKey(target: string, key: string): string {
  return `${target}\u0000${key}`
}

/** Bounded insertion-ordered map of recently classified triage keys.
 *  Re-recording a key that is still inside the window keeps its first-seen
 *  timestamp and position; recording past the cap evicts the oldest key. */
export class RecentKeys {
  private readonly entries = new Map<string, number>()

  constructor(private readonly cap: number = DEFAULT_RECENT_KEYS_CAP) {}

  get size(): number {
    return this.entries.size
  }

  /** True when this `(target, key)` was recorded less than the repeat
   *  window ago. A key recorded exactly at the window boundary is no longer
   *  a repeat. */
  has(target: string, key: string, now: number): boolean {
    const at = this.entries.get(mapKey(target, key))
    if (at === undefined) return false
    const delta = now - at
    if (delta < 0) return false
    return delta < REPEAT_WINDOW_MS
  }

  record(target: string, key: string, now: number): void {
    const id = mapKey(target, key)
    const at = this.entries.get(id)
    if (at !== undefined && now >= at && now - at < REPEAT_WINDOW_MS) return
    this.entries.delete(id)
    this.entries.set(id, now)
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

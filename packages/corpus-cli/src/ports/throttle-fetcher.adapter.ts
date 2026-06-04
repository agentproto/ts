/**
 * ThrottleFetcher — wraps a FetcherPort to enforce a minimum interval
 * between fetches (rate limiting). The importer already calls fetch
 * serially (one URL at a time), so this adds the *pacing* that protects
 * against YouTube anti-abuse blocks and Whisper RPM limits when running
 * a large batch.
 *
 * `now` + `sleep` are injectable so the throttle is unit-testable without
 * real timers.
 */

import type { FetcherPort, FetchedSource } from "@agentproto/corpus"

export interface ThrottleFetcherOptions {
  /** Minimum milliseconds between the START of consecutive fetches. */
  readonly minIntervalMs: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

export class ThrottleFetcher implements FetcherPort {
  private readonly inner: FetcherPort
  private readonly minIntervalMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private lastStart = 0
  private started = false

  constructor(inner: FetcherPort, opts: ThrottleFetcherOptions) {
    this.inner = inner
    this.minIntervalMs = Math.max(0, opts.minIntervalMs)
    this.now = opts.now ?? (() => Date.now())
    this.sleep =
      opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  }

  async fetch(url: string): Promise<FetchedSource | null> {
    if (this.minIntervalMs > 0 && this.started) {
      const wait = this.minIntervalMs - (this.now() - this.lastStart)
      if (wait > 0) await this.sleep(wait)
    }
    this.started = true
    this.lastStart = this.now()
    return this.inner.fetch(url)
  }
}

/**
 * SocialSourcePort — the "handle → footprint" boundary the social kit
 * consumes. The analogue of corpus's FetcherPort (URL → text), but for a
 * person's whole footprint: a paginated, multi-edge stream rather than one
 * document.
 *
 * Structural interface, NOT nominal. Concrete adapters live where the
 * capability lives — one per platform (X GraphQL, LinkedIn Voyager, IG
 * web-private, …), each wrapping the proven site clients behind an injected
 * BrowserPort. The kit never speaks to a platform directly.
 *
 * `capture` is an async iterator so the host can stream + back-pressure on
 * large accounts. A record the adapter cannot produce (slice unsupported,
 * page 403) is simply not yielded; throwing is reserved for hard failures
 * (auth, transport down).
 */

import type { FootprintRecord, Slice } from "../model/footprint.js"

export interface CaptureOptions {
  /** Which slices to pull. Each is a distinct paginated API + cost on-platform. */
  readonly slices: readonly Slice[]
  /** Soft cap on records per slice (pagination depth). Adapter best-effort. */
  readonly limit?: number
  /** Cooperative cancellation for long captures. */
  readonly signal?: AbortSignal
  /**
   * Stable ids already captured in a previous run (post urns, person ids).
   * Adapters MAY use this to stop paginating early once they reach known
   * territory — the resumability hint. Landing is idempotent regardless.
   */
  readonly seen?: ReadonlySet<string>
}

/** Self-description so the orchestrator can warn/skip before it captures. */
export interface SliceSupport {
  readonly slice: Slice
  /** False when the platform structurally blocks this (e.g. IG likers 403). */
  readonly supported: boolean
  /** Relative cost/risk: 1 = cheap public read … 4 = heavy fan-out / stealth. */
  readonly tier: 1 | 2 | 3 | 4
  readonly note?: string
}

export interface SocialSourcePort {
  /** Platform key, e.g. "x", "linkedin", "instagram", "tiktok", "youtube". */
  readonly platform: string

  /** What this adapter can capture, and at what cost — drives pre-flight UX. */
  readonly slices: readonly SliceSupport[]

  /**
   * Capture the footprint for `handle`. Yields the subject's `profile`
   * first (when available), then records for the requested slices.
   */
  capture(
    handle: string,
    opts: CaptureOptions
  ): AsyncIterable<FootprintRecord>
}

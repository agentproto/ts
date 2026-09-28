/**
 * Sentinel auto-link (AIP-60 §6, step 4) — when a session's opened PR is
 * newly recorded (`sessions.ts`'s `recordOpenedPr`, fed by
 * `command_execute`'s stamper AND both `pr-provenance-reconciler.ts` lanes —
 * all three funnel through that one registry call, so this hook fires for
 * every lane without being wired into each separately), create a sentinel
 * watching it for the owning session, unless one already exists.
 *
 * Gated by (in order): the per-spawn opt-out
 * (`SessionDescriptor.sentinelAutoWatch === false`), then
 * `config.sentinel.autoWatchPrs` (resolved fresh per call, same
 * read-per-call discipline as `messaging-defaults.ts` — a `config_set`
 * takes effect on the very next PR, no restart).
 *
 * Idempotent: `recordOpenedPr` itself only fires this hook once per
 * genuinely NEW `(adapter, url)` pair (its own dedupe guard), and this
 * module additionally checks the store for an existing sentinel on the same
 * `(subject, sessionId)` before creating one — belt-and-braces against a
 * race or a sentinel someone already created by hand for the same PR.
 *
 * Strictly best-effort: a missing `gh`, an unavailable provider, or a
 * `create()` failure is logged and swallowed — auto-link must never affect
 * the PR-recording it hangs off of, nor the session's own turn.
 *
 * Dead session note: if the owning session later exits for good (not
 * resumable), this sentinel is NOT cancelled — same as every sentinel, its
 * provider-side watch keeps running (design §2: "the PR is still real").
 * The next event `sentinel-runtime.ts` observes for it hits the same
 * dead-session path every sentinel does: resume via `isSessionAlive`/
 * `restartSession` if possible, else park to `sentinels-parked.jsonl` and
 * mark the sentinel `orphaned` — `sentinel_list` still shows it.
 */

import { parsePrUrl } from "./review-pr.js"
import { GITHUB_DEFAULT_PR_TYPES } from "./sentinel-github-normalize.js"
import { LOCAL_GH_SLUG } from "./sentinel-providers/local-gh.js"
import { singleMatch, type SentinelProviderHandle, type SentinelSpec } from "./sentinel-providers/types.js"
import type { SentinelStore } from "./sentinel-store.js"
import type { RecordOpenedPrInput } from "./sessions.js"

/** The slice of `SessionDescriptor` this module reads — structural so tests
 *  don't need to construct a full descriptor. The real `SessionDescriptor`
 *  satisfies this. */
export interface AutoLinkSession {
  sentinelAutoWatch?: boolean
}

export interface SentinelAutoLinkOptions {
  store: SentinelStore
  resolveProvider: (slug: string) => Promise<SentinelProviderHandle | null>
  /** Resolves `config.sentinel.autoWatchPrs` (with the local-gh-availability
   *  default baked in) — called fresh on every opened PR, never cached. */
  autoWatchPrs: () => Promise<boolean>
  activeIntervalMs?: number
  log?: (line: string) => void
}

export interface SentinelAutoLinker {
  /** Wire this as `createSessionsRegistry`'s `onOpenedPr` option. */
  onOpenedPr: (sessionId: string, input: RecordOpenedPrInput, desc: AutoLinkSession) => void
  /** Same logic as `onOpenedPr`, awaitable — for tests and any caller that
   *  wants to know when auto-link finished rather than fire-and-forget. */
  linkNow: (sessionId: string, input: RecordOpenedPrInput, desc: AutoLinkSession) => Promise<void>
}

export function createSentinelAutoLinker(opts: SentinelAutoLinkOptions): SentinelAutoLinker {
  const log = opts.log ?? ((line: string): void => console.warn(line))

  const alreadyWatching = (subject: string, sessionId: string): boolean =>
    opts.store
      .list()
      .some(
        s =>
          s.spec.target.kind === "session" &&
          s.spec.target.sessionId === sessionId &&
          s.spec.match.some(m => m.subject === subject),
      )

  const link = async (sessionId: string, input: RecordOpenedPrInput, desc: AutoLinkSession): Promise<void> => {
    if (desc.sentinelAutoWatch === false) return

    const enabled = await opts.autoWatchPrs()
    if (!enabled) return

    const parsed = parsePrUrl(input.url)
    if (!parsed) return // not a github.com PR url — local-gh has nothing to watch

    const subject = `github:${parsed.repo}#${parsed.number}`
    if (alreadyWatching(subject, sessionId)) return

    const provider = await opts.resolveProvider(LOCAL_GH_SLUG)
    if (!provider) {
      log(`[sentinel-autolink] provider "${LOCAL_GH_SLUG}" unavailable — not watching ${subject}`)
      return
    }

    const spec: SentinelSpec = {
      match: singleMatch(subject, [...GITHUB_DEFAULT_PR_TYPES]),
      until: { kind: "subject_terminal" },
      target: { kind: "session", sessionId, urgency: "next-turn" },
      provider: LOCAL_GH_SLUG,
      label: `auto:pr#${parsed.number}`,
      group: sessionId,
    }

    try {
      const handle = await provider.create(spec, { mode: "poll", intervalMs: opts.activeIntervalMs ?? 15_000 })
      opts.store.create({ spec, provider: LOCAL_GH_SLUG, handle })
    } catch (err) {
      log(`[sentinel-autolink] failed to auto-watch ${subject}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    onOpenedPr(sessionId, input, desc) {
      void link(sessionId, input, desc).catch(err =>
        log(`[sentinel-autolink] unhandled error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`),
      )
    },
    linkNow: link,
  }
}

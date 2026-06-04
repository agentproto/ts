/**
 * SyncRunner — push refined corpus entries to a SinkPort. Agnostic: it scans
 * `entries/` (via resolveKnowledge), shapes each as a SinkItem, and pushes
 * through the injected sink. The sink (and its host binding) is config, not
 * code here. Sources stay local (raw archive); only refined knowledge syncs.
 */

import type { FsPort } from "../ports/fs.port.js"
import { resolveKnowledge, type KnowledgeQuery } from "../knowledge/resolve.js"
import type { SinkPort, SinkItem, SinkPushResult } from "./types.js"

export interface SyncRunnerOptions {
  readonly fs: FsPort
  readonly sink: SinkPort
  /** Which entries to sync (tags/kinds). Empty = all refined entries. */
  readonly select?: KnowledgeQuery
  /** URI scheme for the item address. Default `corpus`. */
  readonly uriScheme?: string
  /** Pace between pushes (ms). Default 0. */
  readonly throttleMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

export interface SyncReport {
  readonly pushed: number
  readonly skipped: number
  readonly failed: number
  readonly results: readonly SinkPushResult[]
}

export class SyncRunner {
  constructor(private readonly opts: SyncRunnerOptions) {}

  async run(): Promise<SyncReport> {
    const scheme = this.opts.uriScheme ?? "corpus"
    const throttle = this.opts.throttleMs ?? 0
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))

    const entries = await resolveKnowledge({
      fs: this.opts.fs,
      query: this.opts.select ?? {},
    })

    const results: SinkPushResult[] = []
    let pushed = 0
    let skipped = 0
    let failed = 0

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      if (i > 0 && throttle > 0) await sleep(throttle)
      const item: SinkItem = {
        slug: e.slug,
        kind: e.kind,
        title: e.title,
        body: e.body,
        sources: e.sources,
        tags: e.tags,
        confidence: e.confidence,
        ...(e.access ? { access: e.access } : {}),
        uri: `${scheme}://${e.slug}`,
      }
      let res: SinkPushResult
      try {
        res = await this.opts.sink.push(item)
      } catch (err) {
        res = { uri: item.uri, ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      results.push(res)
      if (res.skipped) skipped++
      else if (res.ok) pushed++
      else failed++
    }
    return { pushed, skipped, failed, results }
  }
}

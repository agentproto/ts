/**
 * CompositeFetcher — tries child fetchers in order, first non-null wins.
 *
 * Lets the importer route by URL without itself knowing the routing:
 *   new CompositeFetcher([ ytDlpWhisper, browserReadability ])
 * sends videos to whisper (the readability one returns null for them is
 * never reached because whisper handled it) and everything else falls
 * through to readability. A child that THROWS aborts (hard failure);
 * a child that returns null means "not mine, try the next".
 */

import type { FetcherPort, FetchedSource } from "@agentproto/corpus"

export class CompositeFetcher implements FetcherPort {
  private readonly children: readonly FetcherPort[]

  constructor(children: readonly FetcherPort[]) {
    this.children = children
  }

  async fetch(url: string): Promise<FetchedSource | null> {
    for (const child of this.children) {
      const result = await child.fetch(url)
      if (result) return result
    }
    return null
  }
}

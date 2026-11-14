export interface ReactionReconcileSummary {
  total: number
  pending: number
  running: number
  failed: number
  dead: number
}

export interface BootBuckets {
  servedBucket: string
  otherLiveBuckets: ReadonlySet<string> | undefined
}

/**
 * Reaction receipt crash recovery at boot. Independent of the workspace
 * config: `bootBuckets` is undefined when that config could not be loaded, and
 * recovery still runs. Skipped only when another live daemon serves the same
 * bucket (it owns that bucket's receipt file). Never throws.
 */
export async function reconcileReactionsAtBoot(
  gateway: { reconcileReactionsOnBoot(): Promise<ReactionReconcileSummary> },
  bootBuckets: BootBuckets | undefined,
  write: (line: string) => void,
): Promise<ReactionReconcileSummary | undefined> {
  try {
    if (bootBuckets?.otherLiveBuckets?.has(bootBuckets.servedBucket) === true) return undefined
    const reactions = await gateway.reconcileReactionsOnBoot()
    if (reactions.total > 0) {
      write(
        `reaction receipts: ${reactions.total} (pending ${reactions.pending}, running ${reactions.running}, failed ${reactions.failed}, dead ${reactions.dead})`,
      )
    }
    return reactions
  } catch (err) {
    write(`reaction reconciliation skipped — ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

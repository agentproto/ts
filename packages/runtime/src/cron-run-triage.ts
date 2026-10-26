/** Resolve a cron run's outcome for the `cron-ok` follow-triage rule.
 *
 * Agent crons record their spawned session id on the run, so a direct
 * `sessionId` match is enough. Command crons do not: they record only the
 * job id, and the follow event carries `cron:<jobId>` as its label. Match
 * that label against the job's latest run that ended at or before the exit.
 */

export interface CronRunTriageRecord {
  jobId: string
  ok: boolean
  startedAt: string
  endedAt: string
  sessionId?: string
}

const CRON_LABEL_PREFIX = "cron:"

/** Parse the job id out of a `cron:<jobId>` follow label. */
export function cronJobIdFromLabel(label: string | undefined): string | undefined {
  if (!label?.startsWith(CRON_LABEL_PREFIX)) return undefined
  const jobId = label.slice(CRON_LABEL_PREFIX.length)
  return jobId.length > 0 ? jobId : undefined
}

/**
 * Return the matched run's `ok`, or `undefined` when no run matches (the
 * caller fails open: an unknown run must still wake the follower).
 */
export function resolveCronRunOk(input: {
  runs: readonly CronRunTriageRecord[]
  sessionId: string
  label?: string
  at?: string
}): boolean | undefined {
  const bySession = input.runs.find(run => run.sessionId === input.sessionId)
  if (bySession) return bySession.ok

  const jobId = cronJobIdFromLabel(input.label)
  if (!jobId || !input.at) return undefined
  const exitMs = Date.parse(input.at)
  if (Number.isNaN(exitMs)) return undefined

  let latest: CronRunTriageRecord | undefined
  for (const run of input.runs) {
    if (run.jobId !== jobId) continue
    const endedMs = Date.parse(run.endedAt)
    if (Number.isNaN(endedMs) || endedMs > exitMs) continue
    if (
      !latest ||
      endedMs > Date.parse(latest.endedAt) ||
      (endedMs === Date.parse(latest.endedAt) && run.startedAt > latest.startedAt)
    ) {
      latest = run
    }
  }
  return latest?.ok
}

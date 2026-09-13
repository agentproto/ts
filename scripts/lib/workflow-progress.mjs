/**
 * Pure formatter for a WorkflowRun's poll heartbeat.
 *
 * Split out of `.github/actions/agentproto-run/driver.mjs` so it is unit
 * testable (the driver is a top-level script that boots a daemon on import).
 *
 * Why this exists at all: the driver's `workflow_status` poll loop used to log
 * NOTHING between "started workflow run" and the timeout. PR #1297's reviewer
 * lane produced 15 minutes of dead air followed by a bare "did not reach a
 * terminal status", leaving no way to tell whether the e2b sandbox never
 * booted, the adapter never got a first token, or the model just sat there.
 */

/**
 * Compact one-line progress fingerprint: run status, per-stage status,
 * done/total step counts, and the label (+sessionId) of whatever is RUNNING.
 *
 * Designed to be compared against the previous call's output so the driver can
 * log on CHANGE rather than on every 3-second poll.
 *
 * @param {unknown} run a WorkflowRun (or anything — tolerates partial shapes,
 *   since it is fed straight from an MCP tool result)
 * @returns {string}
 */
export function describeRunProgress(run) {
  const parts = [`status=${run?.status ?? '?'}`]
  for (const stage of Array.isArray(run?.stages) ? run.stages : []) {
    const steps = Array.isArray(stage?.steps) ? stage.steps : []
    const done = steps.filter((s) => s?.status === 'done').length
    const running = steps.filter((s) => s?.status === 'running')
    parts.push(
      `stage${stage?.index ?? '?'}${stage?.label ? `(${stage.label})` : ''}` +
        `=${stage?.status ?? '?'} [${done}/${steps.length}]` +
        (running.length
          ? ` running=${running
              .map((s) => `${s?.label ?? '?'}${s?.sessionId ? `@${s.sessionId}` : ''}`)
              .join(',')}`
          : ''),
    )
  }
  if (run?.awaitingApproval) parts.push(`awaitingApproval=${run.awaitingApproval.approvalId}`)
  if (run?.awaitingSuspend) {
    parts.push(`awaitingSuspend=${(run.awaitingSuspend.on ?? []).join('|')}`)
  }
  return parts.join(' · ')
}

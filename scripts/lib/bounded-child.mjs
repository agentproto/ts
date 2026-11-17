/**
 * Run an agent CLI child (`opencode run`, …) with a hard deadline, and never
 * leave it, or anything it spawned, running after the lane is over.
 *
 * A step's `timeout-minutes` does not stop the agent. On timeout the runner
 * ends the step's shell, and the node script plus its agent child are
 * re-parented and keep running through the following steps; the runner only
 * reaps them at "Complete job" ("Terminate orphan process"). Release run
 * 44007187073 (2026-11-17): the OpenCode docs lane hit its 20-minute step
 * timeout, its agent kept editing docs/cli/verbs/install-mcp.md during the
 * Sonnet fallback and the "Open docs PR" step, and
 * peter-evans/create-pull-request aborted its checkout of the existing
 * docs-sync/auto branch on that freshly dirtied file.
 *
 * So the child runs as the leader of its own process group (`detached`), the
 * deadline sits below the step timeout, and on expiry (or when this process
 * is itself told to stop) the whole group gets SIGTERM, then SIGKILL after a
 * grace period. The group is also swept when the leader exits, so a
 * grandchild it left behind does not outlive the lane either.
 *
 * Run the tests: node --test scripts/lib/bounded-child.test.mjs
 */
import { spawn } from 'node:child_process'

/**
 * Default lane deadline. Every local agent lane step in release.yml has
 * `timeout-minutes: 20`; 17 leaves the script time to stop the group (grace
 * period), undo out-of-scope edits and report its status before the runner
 * cuts the step.
 */
export const DEFAULT_DEADLINE_MINUTES = 17

/**
 * Lane deadline in ms, from `AGENT_DEADLINE_MINUTES`. A value that is not a
 * positive number falls back to the default with a warning instead of
 * throwing: a lane must never lose its deadline over a typo.
 */
export function agentDeadlineMs(env = process.env, warn = console.warn) {
  const raw = env.AGENT_DEADLINE_MINUTES
  if (raw === undefined || raw === '') return DEFAULT_DEADLINE_MINUTES * 60_000
  const minutes = Number(raw)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    warn(`AGENT_DEADLINE_MINUTES=${JSON.stringify(raw)} is not a positive number of minutes; using ${DEFAULT_DEADLINE_MINUTES}.`)
    return DEFAULT_DEADLINE_MINUTES * 60_000
  }
  return Math.round(minutes * 60_000)
}

/**
 * Signal a whole process group; false when it is already gone. Never throws:
 * it runs from timers and child events, where a throw would crash the lane.
 * ESRCH is the usual "nothing left"; macOS answers EPERM instead when the
 * group holds only zombies waiting to be reaped.
 */
function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false
  }
}

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * Spawn `command args`, write `input` to its stdin, collect stdout/stderr.
 * Resolves `{ code, signal, stdout, stderr, timedOut }` once the child's
 * stdio closes; rejects only when the spawn itself fails.
 */
export function runBoundedChild(command, args, { cwd, env, input = '', deadlineMs, graceMs = 10_000 } = {}) {
  if (!(deadlineMs > 0)) throw new Error('runBoundedChild needs a positive deadlineMs')
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killTimer = null
    let settled = false

    const stopGroup = () => {
      if (killTimer || child.pid === undefined) return
      signalGroup(child.pid, 'SIGTERM')
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), graceMs)
    }
    const deadlineTimer = setTimeout(() => {
      timedOut = true
      stopGroup()
    }, deadlineMs)

    // Detached means our own SIGINT/SIGTERM no longer reaches the group, so
    // forward it: kill the group, then let the signal end this process as it
    // would have without the handler.
    const onSignal = (signal) => {
      if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL')
      cleanup()
      process.kill(process.pid, signal)
    }
    for (const signal of FORWARDED_SIGNALS) process.on(signal, onSignal)

    function cleanup() {
      clearTimeout(deadlineTimer)
      clearTimeout(killTimer)
      for (const signal of FORWARDED_SIGNALS) process.removeListener(signal, onSignal)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    // A child that exits before reading its prompt must not crash us (EPIPE).
    child.stdin.on('error', () => {})

    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL')
      reject(error)
    })
    // The leader is gone: sweep what it left in its group, which also
    // releases any stdio pipe a grandchild still held open.
    child.on('exit', () => {
      if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL')
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise({ code, signal, stdout, stderr, timedOut })
    })

    child.stdin.end(input)
  })
}

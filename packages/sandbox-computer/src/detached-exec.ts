/**
 * Detached exec for the `computer` sandbox provider.
 *
 * The controller's exec endpoint is ONE synchronous request. Cloudflare cuts
 * a request at 100 seconds, so a long in-box command fails with a 524 even
 * when it would have finished. This transport writes the command to a script
 * in the box, starts it under `setsid nohup`, and then polls for its exit
 * file with short execs that stay well under that request cut.
 */

import { randomUUID } from "node:crypto"
import type { SandboxExecResult } from "@agentproto/sandbox"
import { ComputerApiError } from "./client.js"
import { shQuote } from "./quote.js"

/** The primitive surface the detached transport needs. All calls are short
 *  synchronous execs plus the file helpers that already run over them. */
export interface DetachedExecIo {
  /** Controller computer id, used only in error messages. */
  id?: string
  exec(
    script: string,
    opts?: { timeoutMs?: number; cwd?: string; env?: Record<string, string> },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>
  writeFile(path: string, data: Uint8Array): Promise<void>
  readFile(path: string): Promise<Uint8Array>
}

export interface DetachedExecOptions {
  /** Total wall clock allowed for the command itself. */
  timeoutMs: number
  cwd?: string
  env?: Record<string, string>
  /** Poll cadence knobs. Production uses 3s backing off to 10s; tests
   *  tighten these so a timeout test does not need real minutes. */
  pollIntervalMs?: number
  maxPollIntervalMs?: number
}

/** Every request this transport issues must stay far under the 100 second
 *  Cloudflare request cut. */
const LAUNCH_TIMEOUT_MS = 30_000
const POLL_TIMEOUT_MS = 30_000
const KILL_TIMEOUT_MS = 15_000
const CLEANUP_TIMEOUT_MS = 15_000
const DEFAULT_POLL_MS = 3_000
const DEFAULT_MAX_POLL_MS = 10_000
const POLL_RETRIES = 3
const LAUNCH_PROBE_ATTEMPTS = 5
const LAUNCH_PROBE_MS = 100

const sleepDefault = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A poll that failed on a transient condition is worth retrying. A box that
 *  is gone (404), not running (409), unauthorised, or rejected (400) is not. */
function isTransientExecError(err: unknown): boolean {
  if (err instanceof ComputerApiError) {
    if (err.status === 0) return true
    if (err.status === 429) return true
    return err.status >= 500 && err.status <= 599
  }
  return false
}

async function execWithRetry(
  io: DetachedExecIo,
  script: string,
  opts: { timeoutMs?: number },
  sleep: (ms: number) => Promise<void>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let lastError: unknown
  for (let attempt = 0; attempt < POLL_RETRIES; attempt++) {
    try {
      return await io.exec(script, opts)
    } catch (err) {
      lastError = err
      if (!isTransientExecError(err) || attempt === POLL_RETRIES - 1) throw err
      await sleep(250 * (attempt + 1))
    }
  }
  throw lastError
}

/** The runner script: run the caller's command, then record its exit code in
 *  a file the host can poll. A trap keeps the exit code even when the command
 *  calls `exit` itself. The exit file is renamed into place so a poll can
 *  never observe it half written. */
function buildRunner(command: string, exitPath: string): string {
  return [
    "#!/bin/bash",
    "__ap_write_exit() {",
    "  __ap_ec=$?",
    `  printf %s "$__ap_ec" > ${shQuote(`${exitPath}.tmp`)}`,
    `  mv ${shQuote(`${exitPath}.tmp`)} ${shQuote(exitPath)}`,
    "}",
    "trap __ap_write_exit EXIT",
    "# __AP_COMMAND_START__",
    command,
    "# __AP_COMMAND_END__",
    "",
  ].join("\n")
}

function timeoutError(id: string | undefined, timeoutMs: number): ComputerApiError {
  return new ComputerApiError(
    504,
    `computer controller 504 on POST /v1/computers/${id ?? "unknown"}/exec: command timed out after ${timeoutMs}ms`,
    "exec-timeout",
  )
}

async function killProcessGroup(io: DetachedExecIo, pidPath: string): Promise<void> {
  const script =
    `pid=$(cat ${shQuote(pidPath)} 2>/dev/null || true); ` +
    `if [ -n "$pid" ]; then kill -TERM -"$pid" 2>/dev/null || true; sleep 1; ` +
    `kill -KILL -"$pid" 2>/dev/null || true; fi; exit 0`
  try {
    await io.exec(script, { timeoutMs: KILL_TIMEOUT_MS })
  } catch {
    // Best effort: the box may already be gone.
  }
}

async function removeDir(io: DetachedExecIo, dir: string): Promise<void> {
  try {
    await io.exec(`rm -rf ${shQuote(dir)}`, { timeoutMs: CLEANUP_TIMEOUT_MS })
  } catch {
    // Best effort cleanup.
  }
}

/**
 * Run one command through the detached transport and return the same
 * `SandboxExecResult` shape a normal exec returns. A non-zero exit is a
 * RESULT, not a throw. A timeout kills the process group and rejects with
 * the timeout error the normal synchronous path surfaces.
 */
export async function detachedExec(
  io: DetachedExecIo,
  command: string,
  opts: DetachedExecOptions,
): Promise<SandboxExecResult> {
  const startedAt = Date.now()
  const dir = `/tmp/.ap-exec/${randomUUID()}`
  const scriptPath = `${dir}/run.sh`
  const stdoutPath = `${dir}/stdout`
  const stderrPath = `${dir}/stderr`
  const exitPath = `${dir}/exit`
  const pidPath = `${dir}/pid`

  const pollStart = opts.pollIntervalMs ?? DEFAULT_POLL_MS
  const pollMax = opts.maxPollIntervalMs ?? DEFAULT_MAX_POLL_MS
  let pollInterval = pollStart

  try {
    await io.writeFile(scriptPath, Buffer.from(buildRunner(command, exitPath), "utf8"))

    // `&` makes the shell's own status `echo`'s (always 0), even when the
    // backgrounded runner could not start (missing setsid/nohup/bash, bad
    // cwd, unreadable script). Probe the child's liveness: if it is gone and
    // wrote no exit file, surface the captured stderr and fail now instead
    // of polling to the timeout for a 504. The probe retries briefly to
    // absorb the race where the runner has exited but its EXIT trap has not
    // yet renamed the exit file into place; the exit-file guard keeps an
    // instantly-finished command from being misreported as a failed launch.
    const launch =
      `setsid nohup bash ${shQuote(scriptPath)} </dev/null ` +
      `> ${shQuote(stdoutPath)} 2> ${shQuote(stderrPath)} & echo $! > ${shQuote(pidPath)}; ` +
      `__ap_pid=$(cat ${shQuote(pidPath)} 2>/dev/null || true); __ap_ok=0; __ap_i=0; ` +
      `while [ "$__ap_i" -lt ${LAUNCH_PROBE_ATTEMPTS} ]; do ` +
      `if [ -f ${shQuote(exitPath)} ] || ` +
      `{ [ -n "$__ap_pid" ] && kill -0 "$__ap_pid" 2>/dev/null; }; then __ap_ok=1; break; fi; ` +
      `__ap_i=$((__ap_i + 1)); sleep ${LAUNCH_PROBE_MS / 1000}; done; ` +
      `if [ "$__ap_ok" -ne 1 ]; then cat ${shQuote(stderrPath)} >&2; exit 1; fi`
    const launched = await io.exec(launch, {
      timeoutMs: LAUNCH_TIMEOUT_MS,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    })
    // A failed launch never starts the runner, so no exit file is ever
    // written. Surface its own error now instead of polling to the timeout.
    if (launched.exitCode !== 0) {
      const tail = (launched.stderr.trim() || launched.stdout.trim()).slice(-400)
      throw new Error(
        `computer "${io.id ?? "unknown"}": detached exec launch failed (exit ${launched.exitCode})` +
          (tail ? `: ${tail}` : ""),
      )
    }

    const deadline = startedAt + opts.timeoutMs
    for (;;) {
      const check = await execWithRetry(
        io,
        `test -f ${shQuote(exitPath)} && exit 0 || exit 65`,
        { timeoutMs: POLL_TIMEOUT_MS },
        sleepDefault,
      )
      if (check.exitCode === 0) break

      const now = Date.now()
      if (now >= deadline) {
        await killProcessGroup(io, pidPath)
        throw timeoutError(io.id, opts.timeoutMs)
      }
      await sleepDefault(Math.min(pollInterval, Math.max(0, deadline - now)))
      pollInterval = Math.min(pollMax, Math.max(1, pollInterval) * 2)
    }

    const exitRaw = Buffer.from(await io.readFile(exitPath)).toString("utf8").trim()
    const exitCode = Number(exitRaw)
    if (!Number.isInteger(exitCode)) {
      throw new Error(`computer "${io.id ?? "unknown"}": detached exec wrote an unreadable exit code (${JSON.stringify(exitRaw)})`)
    }
    const stdout = Buffer.from(await io.readFile(stdoutPath)).toString("utf8")
    const stderr = Buffer.from(await io.readFile(stderrPath)).toString("utf8")
    return { exitCode, stdout, stderr, durationMs: Date.now() - startedAt }
  } finally {
    await removeDir(io, dir)
  }
}

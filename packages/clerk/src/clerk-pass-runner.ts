/**
 * What a clerk pass actually LAUNCHES - the routine arm and the command arm
 * of `ClerkHookRun`.
 *
 * Both arms are fire-and-forget by construction: the runner returns as
 * soon as the work is DISPATCHED, never waiting for the pass to finish.
 * The command arm spawns a detached child (unref'd, stdin/stdout ignored,
 * stderr appended to `~/.agentproto/logs/clerk-<sessionId>.err`) so a long
 * pass can never keep the daemon's event loop busy, and it kills the child
 * when the pass's `timeoutMs` elapses so a stuck pass cannot outlive its
 * budget.
 */

import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

import type { ClerkHookConfig } from "./clerk-hook-config.js"
import type { ClerkPassInput } from "./clerk-turn-end.js"

export interface ClerkCommandSpec {
  command: string
  args: string[]
  cwd?: string
  timeoutMs?: number
  /** File the child's stderr is appended to. Absent: stderr is dropped. */
  stderrLogPath?: string
}

/** `$AGENTPROTO_HOME|~/.agentproto/logs/clerk-<sessionId>.err`. */
export function clerkStderrLogPath(sessionId: string): string {
  const home = process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto")
  return join(home, "logs", `clerk-${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.err`)
}

/** Opens the stderr log for append; null when it cannot be opened (the pass
 *  must still run, just without a journal). */
function openStderrLog(path: string | undefined): number | null {
  if (!path) return null
  try {
    mkdirSync(dirname(path), { recursive: true })
    return openSync(path, "a")
  } catch {
    return null
  }
}

export interface ClerkPassRunnerOptions {
  /** Fire an AIP-41 routine by id (the daemon's routine registrar). */
  triggerRoutine?: (routineId: string) => Promise<unknown> | unknown
  /**
   * Allowlist gate for the command arm: the same default-deny check
   * `command_execute` applies (`.agentproto/allowed-commands.json`). When
   * absent the command arm is REFUSED, never run unchecked: the enabling
   * config can come from a workspace file.
   */
  allowCommand?: (spec: { command: string; args: string[] }) => Promise<boolean> | boolean
  /** Anchor an explicit `run.cwd` against the session's cwd (the same
   *  path-escape guard the shell gates use). Absent: `run.cwd` is used as-is. */
  anchorCwd?: (sessionCwd: string, cwd: string) => string
  /** Spawn the pass' command. Injectable for tests. */
  spawnCommand?: (spec: ClerkCommandSpec) => Promise<unknown> | unknown
  /** Called once per pass that has nothing to run (`run` names neither a
   *  routine nor a command). Default: one `console.info` line. */
  onNothingToRun?: (context: { sessionId: string }) => void
  /** Diagnostic sink. */
  onError?: (err: unknown, context: { sessionId: string }) => void
}

/** Default command arm: a detached, unref'd child with a hard timeout. */
export function spawnClerkCommand(spec: ClerkCommandSpec): Promise<{ code: number | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ReturnType<typeof spawn>
    const errFd = openStderrLog(spec.stderrLogPath)
    try {
      child = spawn(spec.command, spec.args, {
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        detached: true,
        stdio: ["ignore", "ignore", errFd ?? "ignore"],
      })
    } catch (err) {
      rejectPromise(err)
      return
    } finally {
      if (errFd !== null) closeSync(errFd)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    if (spec.timeoutMs && spec.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGTERM")
        } catch {
          /* already gone */
        }
      }, spec.timeoutMs)
      timer.unref?.()
    }
    child.on("error", err => {
      if (timer) clearTimeout(timer)
      rejectPromise(err)
    })
    child.on("exit", code => {
      if (timer) clearTimeout(timer)
      resolvePromise({ code })
    })
    child.unref()
  })
}

/**
 * Build the function the clerk-turn-end controller calls to run a pass.
 *
 * The RUN spec decides the arm:
 *   - `run.routine` → the routine registrar fires that routine (out of
 *     band, exactly like `cron_run` bypasses a job's schedule);
 *   - `run.command` → the command is checked against the command allowlist,
 *     then spawned detached in the session's working directory.
 *
 * A spec naming NEITHER (the built-in default is `run: {}`) is a clean
 * no-op: nothing is launched and one info line says why. It is not an error,
 * so enabling the clerk without saying what to run never produces a failing
 * pass.
 */
export function createClerkPassRunner(opts: ClerkPassRunnerOptions) {
  const spawnCommand = opts.spawnCommand ?? spawnClerkCommand
  const onError =
    opts.onError ??
    ((err: unknown, ctx: { sessionId: string }) =>
      console.error(`[runtime] clerk pass failed for session ${ctx.sessionId}:`, err))

  const onNothingToRun =
    opts.onNothingToRun ??
    ((ctx: { sessionId: string }) =>
      console.info(
        `[runtime] clerk pass skipped for session ${ctx.sessionId}: the clerk is enabled but run names no routine or command (set run.routine or run.command)`,
      ))

  return async function runClerkPass(input: ClerkPassInput): Promise<unknown> {
    const config: ClerkHookConfig = input.config
    const run = config.run
    if (run.routine) {
      if (!opts.triggerRoutine) {
        throw new Error("clerk hook names a routine but no routine trigger is wired")
      }
      return await opts.triggerRoutine(run.routine)
    }
    if (run.command) {
      // `$SESSION_ID` in an arg is replaced by the id of the session the
      // pass runs for.
      const args = (run.args ?? []).map(a => a.split("$SESSION_ID").join(input.sessionId))
      const baseName = basename(run.command)
      if (!opts.allowCommand || !(await opts.allowCommand({ command: baseName, args }))) {
        throw new Error(
          `clerk hook command '${baseName}' is not in the command allowlist (.agentproto/allowed-commands.json)`,
        )
      }
      const sessionCwd = input.session.cwd
      const cwd =
        run.cwd !== undefined
          ? sessionCwd && opts.anchorCwd
            ? opts.anchorCwd(sessionCwd, run.cwd)
            : run.cwd
          : sessionCwd
      return await spawnCommand({
        command: run.command,
        args,
        ...(cwd ? { cwd } : {}),
        ...(run.timeoutMs ? { timeoutMs: run.timeoutMs } : {}),
        stderrLogPath: clerkStderrLogPath(input.sessionId),
      })
    }
    onNothingToRun({ sessionId: input.sessionId })
    return { skipped: "nothing-to-run" as const }
  }
}

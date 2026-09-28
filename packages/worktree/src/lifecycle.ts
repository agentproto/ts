import { mkdir, appendFile } from "node:fs/promises"
import { dirname } from "node:path"
import { normalizeHook, type AgentprotoConfig } from "./config.js"
import { hookEnv, resolveWorktreesTurboCacheDir, type WorktreeEnvContext } from "./env.js"
import { execShell, type ExecResult } from "./exec.js"

/** One hook command's result, kept for error reporting / logging. */
export interface HookRun {
  command: string
  result: ExecResult
}

/**
 * Lines that are pure environment noise, never diagnostic signal — filtered
 * OUT of the short `HookError` message (but never out of the persisted full
 * log; {@link appendHookLog} writes the raw, unfiltered result). Today this
 * is exactly the per-worktree `.npmrc` warning every `pnpm` invocation prints
 * when `NODE_AUTH_TOKEN` isn't set in the hook's env — harmless, but its
 * bare presence in `result.stderr` used to make the OLD `(stderr ||
 * stdout)` selection below pick stderr and silently drop the real failure,
 * which lived in stdout (turbo's per-task build output). See `HookError`'s
 * doc for the incident this fixes.
 */
const NOISE_LINE_RES: readonly RegExp[] = [
  /Failed to replace env in config: \$\{NODE_AUTH_TOKEN\}/,
  /^\s*WARN\s+Issue while reading ".*\.npmrc"\.?\s*$/,
]

/** How many trailing lines of the combined, noise-filtered output ride along
 *  in the short `HookError` message. Large enough to carry the actual
 *  failing task's own error (a tsup/tsc diagnostic, a turbo task summary),
 *  small enough to stay a "short, readable" `lastError`
 *  (`sessions.ts`'s `PendingAgentOutcome.message` doc) — the FULL output
 *  always lives in the persisted log file (see {@link appendHookLog}),
 *  referenced by path in this same message. */
const TAIL_LINES = 60

/**
 * Combine stdout+stderr (stdout first — turbo/tsup/tsc write a failing
 * task's own diagnostics there; stderr is usually just the shell's own
 * "command exited" noise) and take the last {@link TAIL_LINES} non-noise
 * lines. This is deliberately DIFFERENT from the old
 * `(stderr || stdout).trim()` selection, which picked ONE stream whole and
 * silently dropped the other — see `HookError`'s doc.
 */
function filteredTail(result: ExecResult): string {
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n")
  const lines = combined
    .split("\n")
    .filter(line => !NOISE_LINE_RES.some(re => re.test(line)))
  const tail = lines.slice(-TAIL_LINES).join("\n").trim()
  return tail || "(no output captured)"
}

/** Raised when a `setup` hook exits non-zero — carries the captured output
 *  (see {@link result}) plus a short, noise-filtered tail in `message` for
 *  callers that only surface a single string (e.g.
 *  `SessionDescriptor.lastError`).
 *
 *  Incident (2026-09-27): three back-to-back `agent_start` worktree
 *  provisions all failed at `pnpm build`, but every `lastError` showed only
 *  the `.npmrc`/`NODE_AUTH_TOKEN` warning + turbo's one-line run summary —
 *  never the actual tsup/tsc error. Root cause: the OLD message used
 *  `(run.result.stderr || run.result.stdout).trim()` — since that WARN line
 *  (and turbo's failure banner) land on stderr, ANY non-empty stderr threw
 *  away stdout WHOLESALE, and stdout is exactly where a failing package's
 *  own build error prints. Fixed by combining both streams, filtering only
 *  the known-noise lines (not a whole stream), and keeping a real tail of
 *  the combined output instead of picking one stream whole. */
export class HookError extends Error {
  readonly command: string
  readonly result: ExecResult
  /** Path to the full, unfiltered stdout+stderr log for this and every
   *  other hook command in the same run, when the caller asked for one to
   *  be persisted (see {@link runSetup}'s `opts.logPath`). */
  readonly logPath?: string
  constructor(phase: "setup" | "teardown", run: HookRun, logPath?: string) {
    super(
      `worktree ${phase} hook failed (exit ${run.result.exitCode}): ${run.command}\n` +
        filteredTail(run.result) +
        (logPath ? `\n\n(full hook output: ${logPath})` : ""),
    )
    this.name = "HookError"
    this.command = run.command
    this.result = run.result
    if (logPath !== undefined) this.logPath = logPath
  }
}

/**
 * Append one hook command's FULL, unfiltered stdout+stderr to `logPath` —
 * best-effort: a log-write failure (unwritable dir, full disk) is swallowed
 * rather than letting log persistence itself break worktree provisioning.
 * No-op when `logPath` is omitted (the common case: a bare `worktree new`
 * from the CLI has no session to log into).
 */
async function appendHookLog(
  logPath: string | undefined,
  command: string,
  result: ExecResult,
): Promise<void> {
  if (!logPath) return
  try {
    await mkdir(dirname(logPath), { recursive: true })
    const parts = [
      `$ ${command}`,
      result.stdout,
      result.stderr,
      `(exit ${result.exitCode})`,
      "",
    ].filter(Boolean)
    await appendFile(logPath, parts.join("\n") + "\n", "utf8")
  } catch {
    // Best-effort — see doc above.
  }
}

/**
 * Run the `worktree.setup` hooks sequentially in the worktree, with the
 * `AGENTPROTO_*` context env injected — plus `TURBO_CACHE_DIR`, pointed at a
 * directory shared across every provisioned worktree (see
 * {@link resolveWorktreesTurboCacheDir}), so a `pnpm build` (or any other
 * turbo-driven build) run BY a setup hook restores from cache instead of
 * paying a full cold build every single time a worktree is provisioned. A
 * setup hook that doesn't use turbo simply never reads the var. The first
 * non-zero exit throws {@link HookError} (setup failure must fail
 * provisioning). No-op when the repo declares no setup.
 *
 * `opts.logPath`, when given, gets every command's FULL stdout+stderr
 * appended (success or failure) — see {@link appendHookLog}. Callers that
 * know the failure will surface through a single short string (the daemon's
 * `agent_start` path, via `SessionDescriptor.lastError`) should pass a path
 * under that session's own directory so the full log outlives a
 * subsequently-reclaimed worktree.
 *
 * `opts.retryOnFailure` (default `false`) re-runs a failing command exactly
 * ONCE before giving up — a COMPLEMENT to, never a substitute for, an actual
 * root-cause fix. It exists for the unattended `agent_start` path: a caller
 * with no human watching has no way to retry a transient failure itself
 * short of minting an entirely new worktree (a fresh `git worktree add`,
 * paying the full setup cost again) — see `session-spawn.ts`'s
 * `worktreeSetupLogPath` call sites, which both opt in. Left `false` for the
 * default (`agentproto worktree new`, and this function's own default): an
 * interactive human watching a genuine, deterministic build failure gets it
 * on the first try instead of waiting through an identical, doomed rerun.
 * Both attempts are logged (when `logPath` is given); the thrown
 * `HookError` carries the RETRY's own result, since that's the one the
 * caller is actually giving up on.
 */
export async function runSetup(
  config: AgentprotoConfig,
  ctx: WorktreeEnvContext,
  opts: { logPath?: string; retryOnFailure?: boolean } = {},
): Promise<HookRun[]> {
  const commands = normalizeHook(config.worktree?.setup)
  const runs: HookRun[] = []
  const env = { ...hookEnv(ctx), TURBO_CACHE_DIR: resolveWorktreesTurboCacheDir() }
  for (const command of commands) {
    let result = await execShell(command, ctx.worktreePath, { env })
    let run = { command, result }
    runs.push(run)
    await appendHookLog(opts.logPath, command, result)
    if (result.exitCode !== 0 && opts.retryOnFailure) {
      result = await execShell(command, ctx.worktreePath, { env })
      run = { command, result }
      runs.push(run)
      await appendHookLog(opts.logPath, `${command} (retry 1/1)`, result)
    }
    if (result.exitCode !== 0) throw new HookError("setup", run, opts.logPath)
  }
  return runs
}

/**
 * Run the `worktree.teardown` hooks sequentially. Unlike setup, a failing
 * teardown hook does NOT throw — cleanup must proceed — so failures are
 * returned for the caller to log. No-op when no teardown is declared.
 * `opts.logPath` mirrors {@link runSetup}'s — best-effort, full output.
 */
export async function runTeardown(
  config: AgentprotoConfig,
  ctx: WorktreeEnvContext,
  opts: { logPath?: string } = {},
): Promise<HookRun[]> {
  const commands = normalizeHook(config.worktree?.teardown)
  const runs: HookRun[] = []
  const env = hookEnv(ctx)
  for (const command of commands) {
    const result = await execShell(command, ctx.worktreePath, { env })
    runs.push({ command, result })
    await appendHookLog(opts.logPath, command, result)
  }
  return runs
}

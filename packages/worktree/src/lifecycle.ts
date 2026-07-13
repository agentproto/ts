import { normalizeHook, type AgentprotoConfig } from "./config.js"
import { hookEnv, type WorktreeEnvContext } from "./env.js"
import { execShell, type ExecResult } from "./exec.js"

/** One hook command's result, kept for error reporting / logging. */
export interface HookRun {
  command: string
  result: ExecResult
}

/** Raised when a `setup` hook exits non-zero — carries the captured output. */
export class HookError extends Error {
  readonly command: string
  readonly result: ExecResult
  constructor(phase: "setup" | "teardown", run: HookRun) {
    super(
      `worktree ${phase} hook failed (exit ${run.result.exitCode}): ${run.command}\n` +
        (run.result.stderr || run.result.stdout).trim(),
    )
    this.name = "HookError"
    this.command = run.command
    this.result = run.result
  }
}

/**
 * Run the `worktree.setup` hooks sequentially in the worktree, with the
 * `AGENTPROTO_*` context env injected. The first non-zero exit throws
 * {@link HookError} (setup failure must fail provisioning). No-op when the
 * repo declares no setup.
 */
export async function runSetup(
  config: AgentprotoConfig,
  ctx: WorktreeEnvContext,
): Promise<HookRun[]> {
  const commands = normalizeHook(config.worktree?.setup)
  const runs: HookRun[] = []
  const env = hookEnv(ctx)
  for (const command of commands) {
    const result = await execShell(command, ctx.worktreePath, { env })
    const run = { command, result }
    runs.push(run)
    if (result.exitCode !== 0) throw new HookError("setup", run)
  }
  return runs
}

/**
 * Run the `worktree.teardown` hooks sequentially. Unlike setup, a failing
 * teardown hook does NOT throw — cleanup must proceed — so failures are
 * returned for the caller to log. No-op when no teardown is declared.
 */
export async function runTeardown(
  config: AgentprotoConfig,
  ctx: WorktreeEnvContext,
): Promise<HookRun[]> {
  const commands = normalizeHook(config.worktree?.teardown)
  const runs: HookRun[] = []
  const env = hookEnv(ctx)
  for (const command of commands) {
    const result = await execShell(command, ctx.worktreePath, { env })
    runs.push({ command, result })
  }
  return runs
}

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSetup, runTeardown, HookError } from "../lifecycle.js"
import type { AgentprotoConfig } from "../config.js"
import type { WorktreeEnvContext } from "../env.js"

/**
 * Unit coverage for the 2026-09-27 incident fix: a failing `worktree.setup`
 * hook's `lastError` used to show only the `.npmrc`/`NODE_AUTH_TOKEN` noise
 * (which lands on stderr) and never the real diagnostic (which, for a
 * turbo/tsup/tsc build, lands on stdout) — because the OLD message picked
 * `stderr || stdout` as a WHOLE stream rather than combining + filtering.
 * These tests exercise `runSetup`/`runTeardown`/`HookError` directly, with
 * no git worktree needed (mirrors `lifecycle-integration.test.ts`'s own
 * "no git needed" framing for the pure hook-running pieces).
 *
 * Each hook body is a real `.mjs` script file (not an inline `node -e`
 * one-liner) so quoting the NODE_AUTH_TOKEN-shaped noise string never has to
 * survive a second layer of shell escaping.
 */

const NOISE_LINE = 'WARN Issue while reading ".npmrc". Failed to replace env in config: ${NODE_AUTH_TOKEN}'

describe("runSetup / HookError", () => {
  const cleanupPaths: string[] = []

  afterEach(async () => {
    while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
  })

  async function makeCtx(): Promise<WorktreeEnvContext> {
    const dir = await mkdtemp(join(tmpdir(), "wt-lifecycle-"))
    cleanupPaths.push(dir)
    return { sourceCheckoutPath: dir, worktreePath: dir, branchName: "wt/test" }
  }

  /** Write a script under `dir` that prints `stdoutLines` to stdout,
   *  `stderrLines` to stderr, then exits with `exitCode`. Returns the
   *  `node <path>` command for a `worktree.setup` entry. */
  async function writeHookScript(
    dir: string,
    name: string,
    opts: { stdoutLines?: string[]; stderrLines?: string[]; exitCode: number },
  ): Promise<string> {
    const path = join(dir, name)
    const body = [
      ...(opts.stdoutLines ?? []).map(line => `console.log(${JSON.stringify(line)})`),
      ...(opts.stderrLines ?? []).map(line => `console.error(${JSON.stringify(line)})`),
      `process.exit(${opts.exitCode})`,
    ].join("\n")
    await writeFile(path, body, "utf8")
    return `node ${JSON.stringify(path)}`
  }

  /** Write a script under `dir` that tracks its own invocation count in a
   *  sibling counter file and, on each successive invocation, behaves per
   *  the corresponding entry of `attempts` (clamped to the last entry once
   *  exhausted). Used to exercise `opts.retryOnFailure`, where the SAME
   *  command is re-run and must behave differently across attempts. Returns
   *  the `node <path>` command plus the counter file's path so tests can
   *  assert exactly how many times the hook actually ran. */
  async function writeFlakyHookScript(
    dir: string,
    name: string,
    opts: { attempts: Array<{ exitCode: number; stdout?: string }> },
  ): Promise<{ command: string; counterPath: string }> {
    const path = join(dir, name)
    const counterPath = join(dir, `${name}.count`)
    const body = [
      `import { readFileSync, writeFileSync } from "node:fs"`,
      `const counterPath = ${JSON.stringify(counterPath)}`,
      `let n = 0`,
      `try { n = parseInt(readFileSync(counterPath, "utf8"), 10) } catch {}`,
      `n += 1`,
      `writeFileSync(counterPath, String(n))`,
      `const attempts = ${JSON.stringify(opts.attempts)}`,
      `const attempt = attempts[Math.min(n - 1, attempts.length - 1)]`,
      `if (attempt.stdout) console.log(attempt.stdout)`,
      `process.exit(attempt.exitCode)`,
    ].join("\n")
    await writeFile(path, body, "utf8")
    return { command: `node ${JSON.stringify(path)}`, counterPath }
  }

  it("retryOnFailure: a hook that fails once then succeeds resolves, and the log shows both attempts", async () => {
    const ctx = await makeCtx()
    const logDir = await mkdtemp(join(tmpdir(), "wt-lifecycle-retry-log-"))
    cleanupPaths.push(logDir)
    const logPath = join(logDir, "setup.log")
    const { command, counterPath } = await writeFlakyHookScript(ctx.worktreePath, "flaky.mjs", {
      attempts: [
        { exitCode: 1, stdout: "attempt 1 failing" },
        { exitCode: 0, stdout: "attempt 2 succeeded" },
      ],
    })
    const config: AgentprotoConfig = { worktree: { setup: [command] } }
    const runs = await runSetup(config, ctx, { logPath, retryOnFailure: true })
    expect(runs).toHaveLength(2)
    expect(runs[0]?.result.exitCode).toBe(1)
    expect(runs[1]?.result.exitCode).toBe(0)
    const fullLog = await readFile(logPath, "utf8")
    expect(fullLog).toContain("attempt 1 failing")
    expect(fullLog).toContain("attempt 2 succeeded")
    expect(fullLog).toContain("(retry 1/1)")
    expect(parseInt(await readFile(counterPath, "utf8"), 10)).toBe(2)
  })

  it("retryOnFailure: a hook that fails twice throws HookError (with the retry's own result) after exactly 2 executions, log labeled '(retry 1/1)'", async () => {
    const ctx = await makeCtx()
    const logDir = await mkdtemp(join(tmpdir(), "wt-lifecycle-retry-log-"))
    cleanupPaths.push(logDir)
    const logPath = join(logDir, "setup.log")
    const { command, counterPath } = await writeFlakyHookScript(ctx.worktreePath, "flaky.mjs", {
      attempts: [
        { exitCode: 1, stdout: "attempt 1 failing" },
        { exitCode: 1, stdout: "attempt 2 also failing" },
      ],
    })
    const config: AgentprotoConfig = { worktree: { setup: [command] } }
    try {
      await runSetup(config, ctx, { logPath, retryOnFailure: true })
      expect.unreachable("runSetup should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(HookError)
      const hookErr = err as HookError
      // The thrown error reflects the RETRY's own result, not the first
      // attempt's — matches `runSetup`'s docblock.
      expect(hookErr.message).toContain("attempt 2 also failing")
    }
    expect(parseInt(await readFile(counterPath, "utf8"), 10)).toBe(2)
    const fullLog = await readFile(logPath, "utf8")
    expect(fullLog).toContain("(retry 1/1)")
    expect(fullLog).toContain("attempt 1 failing")
    expect(fullLog).toContain("attempt 2 also failing")
  })

  it("combines stdout+stderr and keeps the real diagnostic even when stderr is non-empty", async () => {
    const ctx = await makeCtx()
    // Mirrors the incident shape: a noise line on stderr (the .npmrc/
    // NODE_AUTH_TOKEN warning), plus the REAL diagnostic on stdout — the OLD
    // `(stderr || stdout)` selection would have picked stderr whole and
    // dropped the stdout diagnostic entirely.
    const cmd = await writeHookScript(ctx.worktreePath, "setup.mjs", {
      stdoutLines: ["@agentproto/runtime#build: error TS2322: Type mismatch"],
      stderrLines: [NOISE_LINE],
      exitCode: 1,
    })
    const config: AgentprotoConfig = { worktree: { setup: [cmd] } }
    try {
      await runSetup(config, ctx)
      expect.unreachable("runSetup should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(HookError)
      const hookErr = err as HookError
      expect(hookErr.message).toContain("error TS2322: Type mismatch")
      expect(hookErr.message).not.toContain("NODE_AUTH_TOKEN")
    }
  })

  it("persists the FULL unfiltered output (noise line included) to logPath, and references it in the message", async () => {
    const ctx = await makeCtx()
    const logDir = await mkdtemp(join(tmpdir(), "wt-lifecycle-log-"))
    cleanupPaths.push(logDir)
    const logPath = join(logDir, "nested", "setup.log")
    const cmd = await writeHookScript(ctx.worktreePath, "setup.mjs", {
      stdoutLines: ["real build error here"],
      stderrLines: [NOISE_LINE],
      exitCode: 1,
    })
    const config: AgentprotoConfig = { worktree: { setup: [cmd] } }
    try {
      await runSetup(config, ctx, { logPath })
      expect.unreachable("runSetup should have thrown")
    } catch (err) {
      const hookErr = err as HookError
      expect(hookErr.logPath).toBe(logPath)
      expect(hookErr.message).toContain(logPath)
    }
    const fullLog = await readFile(logPath, "utf8")
    // The full log keeps the noise line — only the short message filters it.
    expect(fullLog).toContain("NODE_AUTH_TOKEN")
    expect(fullLog).toContain("real build error here")
    expect(fullLog).toContain("(exit 1)")
  })

  it("logs every command, including ones that succeed, when a multi-command setup later fails", async () => {
    const ctx = await makeCtx()
    const logDir = await mkdtemp(join(tmpdir(), "wt-lifecycle-log-"))
    cleanupPaths.push(logDir)
    const logPath = join(logDir, "setup.log")
    const installCmd = await writeHookScript(ctx.worktreePath, "install.mjs", {
      stdoutLines: ["install step ok"],
      exitCode: 0,
    })
    const buildCmd = await writeHookScript(ctx.worktreePath, "build.mjs", {
      stdoutLines: ["build step failing"],
      exitCode: 1,
    })
    const config: AgentprotoConfig = { worktree: { setup: [installCmd, buildCmd] } }
    await expect(runSetup(config, ctx, { logPath })).rejects.toThrow(HookError)
    const fullLog = await readFile(logPath, "utf8")
    expect(fullLog).toContain("install step ok")
    expect(fullLog).toContain("build step failing")
  })

  it("never throws when the log directory can't be created (best-effort persistence)", async () => {
    const ctx = await makeCtx()
    // A file, not a directory — `mkdir(dirname(logPath), {recursive:true})`
    // fails because a path component collides with a regular file.
    const blockerDir = await mkdtemp(join(tmpdir(), "wt-lifecycle-blocker-"))
    cleanupPaths.push(blockerDir)
    const blockerPath = join(blockerDir, "not-a-dir")
    await writeFile(blockerPath, "")
    const logPath = join(blockerPath, "nested", "setup.log")
    const cmd = await writeHookScript(ctx.worktreePath, "setup.mjs", { stdoutLines: ["ok"], exitCode: 0 })
    const config: AgentprotoConfig = { worktree: { setup: [cmd] } }
    // Setup itself still succeeds — a broken log path must never break
    // provisioning.
    await expect(runSetup(config, ctx, { logPath })).resolves.toBeDefined()
  })

  it("no logPath given → HookError message carries no log reference, still keeps the filtered tail", async () => {
    const ctx = await makeCtx()
    const cmd = await writeHookScript(ctx.worktreePath, "setup.mjs", {
      stdoutLines: ["diagnostic line"],
      exitCode: 1,
    })
    const config: AgentprotoConfig = { worktree: { setup: [cmd] } }
    try {
      await runSetup(config, ctx)
      expect.unreachable("runSetup should have thrown")
    } catch (err) {
      const hookErr = err as HookError
      expect(hookErr.logPath).toBeUndefined()
      expect(hookErr.message).toContain("diagnostic line")
      expect(hookErr.message).not.toContain("full hook output")
    }
  })

  it("truncates to the trailing lines rather than the leading ones, so the actual failure survives a noisy hook", async () => {
    const ctx = await makeCtx()
    // Emit far more than the internal tail window, with the real diagnostic
    // as the LAST line before exiting — the fix must keep the tail, not an
    // arbitrary truncation that could drop it too.
    const noisy = Array.from({ length: 200 }, (_, i) => `noise line ${i}`)
    const cmd = await writeHookScript(ctx.worktreePath, "setup.mjs", {
      stdoutLines: [...noisy, "THE ACTUAL FAILURE"],
      exitCode: 1,
    })
    const config: AgentprotoConfig = { worktree: { setup: [cmd] } }
    try {
      await runSetup(config, ctx)
      expect.unreachable("runSetup should have thrown")
    } catch (err) {
      const hookErr = err as HookError
      expect(hookErr.message).toContain("THE ACTUAL FAILURE")
    }
  })
})

describe("runTeardown", () => {
  const cleanupPaths: string[] = []
  afterEach(async () => {
    while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
  })

  it("never throws on a failing teardown hook, but still persists its output when logPath is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-lifecycle-teardown-"))
    cleanupPaths.push(dir)
    const ctx: WorktreeEnvContext = { sourceCheckoutPath: dir, worktreePath: dir, branchName: "wt/test" }
    const logDir = await mkdtemp(join(tmpdir(), "wt-lifecycle-teardown-log-"))
    cleanupPaths.push(logDir)
    const logPath = join(logDir, "teardown.log")
    const scriptPath = join(dir, "teardown.mjs")
    await writeFile(scriptPath, `console.log("cleanup failed")\nprocess.exit(1)`, "utf8")
    const config: AgentprotoConfig = {
      worktree: { teardown: [`node ${JSON.stringify(scriptPath)}`] },
    }
    const runs = await runTeardown(config, ctx, { logPath })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.result.exitCode).toBe(1)
    const fullLog = await readFile(logPath, "utf8")
    expect(fullLog).toContain("cleanup failed")
  })
})

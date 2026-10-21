import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSetup } from "../lifecycle.js"
import type { AgentprotoConfig } from "../config.js"
import type { WorktreeEnvContext } from "../env.js"

/**
 * The 2026-10-21 incident: a `worktree.setup` hook that runs `pnpm install`
 * failed with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`: pnpm wanted to
 * prompt about purging a stale modules directory and the daemon spawns every
 * hook WITHOUT a TTY. Three executors died on it before writing any code.
 *
 * The fix makes the spawned hook environment explicitly non-interactive:
 * `CI=true` (unless the caller already set it) and
 * `npm_config_confirm_modules_purge=false` (pnpm reads `npm_config_*` env),
 * plus a stdin that is not a TTY at all.
 */

const cleanupPaths: string[] = []

afterEach(async () => {
  while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function makeCtx(): Promise<WorktreeEnvContext> {
  const dir = await mkdtemp(join(tmpdir(), "wt-lifecycle-env-"))
  cleanupPaths.push(dir)
  return { sourceCheckoutPath: dir, worktreePath: dir, branchName: "wt/test" }
}

/** A hook that prints its own non-interactive env facts as one JSON line. */
async function writeEnvProbe(dir: string): Promise<string> {
  const path = join(dir, "probe.mjs")
  const body = [
    `console.log(JSON.stringify({`,
    `  ci: process.env.CI ?? null,`,
    `  purge: process.env.npm_config_confirm_modules_purge ?? null,`,
    `  stdinIsTty: Boolean(process.stdin.isTTY),`,
    `}))`,
  ].join("\n")
  await writeFile(path, body, "utf8")
  return `node ${JSON.stringify(path)}`
}

function parseProbe(stdout: string): {
  ci: string | null
  purge: string | null
  stdinIsTty: boolean
} {
  const line = stdout
    .split("\n")
    .map(l => l.trim())
    .find(l => l.startsWith("{") && l.endsWith("}"))
  expect(line, `no probe line in ${JSON.stringify(stdout)}`).toBeDefined()
  return JSON.parse(line as string)
}

describe("runSetup: non-interactive hook environment", () => {
  it("spawns the setup hook with CI=true and npm_config_confirm_modules_purge=false, and no TTY on stdin", async () => {
    const ctx = await makeCtx()
    const command = await writeEnvProbe(ctx.worktreePath)
    const config: AgentprotoConfig = { worktree: { setup: [command] } }
    const runs = await runSetup(config, ctx)
    const probe = parseProbe(runs[0]!.result.stdout)
    expect(probe.ci).toBe("true")
    expect(probe.purge).toBe("false")
    expect(probe.stdinIsTty).toBe(false)
  })

  it("preserves an explicit CI value from the caller's environment instead of forcing true", async () => {
    vi.stubEnv("CI", "false")
    const ctx = await makeCtx()
    const command = await writeEnvProbe(ctx.worktreePath)
    const config: AgentprotoConfig = { worktree: { setup: [command] } }
    const runs = await runSetup(config, ctx)
    const probe = parseProbe(runs[0]!.result.stdout)
    expect(probe.ci).toBe("false")
    // The purge flag is still forced off; nothing else in the env asks for it.
    expect(probe.purge).toBe("false")
  })

  it("preserves an explicit CI value passed as an override by the caller", async () => {
    const ctx = await makeCtx()
    const command = await writeEnvProbe(ctx.worktreePath)
    const config: AgentprotoConfig = { worktree: { setup: [command] } }
    const runs = await runSetup(config, ctx, { env: { CI: "explicit-from-config" } })
    const probe = parseProbe(runs[0]!.result.stdout)
    expect(probe.ci).toBe("explicit-from-config")
  })

  it("preserves an explicit npm_config_confirm_modules_purge value from the caller's environment", async () => {
    vi.stubEnv("npm_config_confirm_modules_purge", "true")
    const ctx = await makeCtx()
    const command = await writeEnvProbe(ctx.worktreePath)
    const config: AgentprotoConfig = { worktree: { setup: [command] } }
    const runs = await runSetup(config, ctx)
    const probe = parseProbe(runs[0]!.result.stdout)
    expect(probe.purge).toBe("true")
  })
})

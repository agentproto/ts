import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runTool } from "@agentproto/driver"
import { provisionWorktreeTool } from "../tools/index.js"
import { worktreeProvider } from "../provider/worktree-provider.js"
import { execGit } from "../exec.js"
import { provisionScheduler, runWithProvisionContext, DEFAULT_PROVISION_LIMITS } from "../provision-scheduler.js"
import {
  DEFAULT_PROVISION_MAX_MS,
  DEFAULT_PROVISION_STALL_TIMEOUT_MS,
  PROVISION_MAX_ENV,
  PROVISION_STALL_TIMEOUT_ENV,
  ProvisionTimeoutError,
  resolveProvisionTimeouts,
  startProvisionWatchdog,
} from "../provision-watchdog.js"

describe("resolveProvisionTimeouts", () => {
  it("defaults to a 2 minute stall timeout and a 30 minute cap", () => {
    expect(resolveProvisionTimeouts(undefined, {}, {})).toEqual({
      stallTimeoutMs: 120_000,
      maxMs: 1_800_000,
    })
    expect(DEFAULT_PROVISION_STALL_TIMEOUT_MS).toBe(120_000)
    expect(DEFAULT_PROVISION_MAX_MS).toBe(1_800_000)
  })

  it("resolves per-spawn > env > config > default, 0 meaning off", () => {
    const cfg = { provisionStallTimeoutMs: 5, provisionMaxMs: 6 }
    expect(resolveProvisionTimeouts(cfg, {}, {})).toEqual({ stallTimeoutMs: 5, maxMs: 6 })
    const env = { [PROVISION_STALL_TIMEOUT_ENV]: "7", [PROVISION_MAX_ENV]: "8" }
    expect(resolveProvisionTimeouts(cfg, {}, env)).toEqual({ stallTimeoutMs: 7, maxMs: 8 })
    expect(resolveProvisionTimeouts(cfg, { stallTimeoutMs: 0, maxMs: 9 }, env)).toEqual({
      stallTimeoutMs: 0,
      maxMs: 9,
    })
  })

  it("ignores invalid values instead of throwing", () => {
    const env = { [PROVISION_STALL_TIMEOUT_ENV]: "soon" }
    expect(resolveProvisionTimeouts({ provisionStallTimeoutMs: -3, provisionMaxMs: 1.5 }, {}, env)).toEqual({
      stallTimeoutMs: 120_000,
      maxMs: 1_800_000,
    })
  })
})

describe("startProvisionWatchdog", () => {
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

  it("trips on silence, naming the phase, elapsed time and the last output lines", async () => {
    const wd = startProvisionWatchdog({ stallTimeoutMs: 80, maxMs: 0, logPath: "/tmp/setup.log" })
    wd.phase("setup", true)
    wd.output("cloning nested repos\nresolving deps\n")
    await sleep(250)
    expect(wd.signal.aborted).toBe(true)
    const trip = wd.tripped()
    expect(trip).toBeInstanceOf(ProvisionTimeoutError)
    expect(trip?.kind).toBe("stall")
    expect(trip?.message).toContain('phase "setup"')
    expect(trip?.message).toContain("no output for")
    expect(trip?.message).toContain("resolving deps")
    expect(trip?.message).toContain("/tmp/setup.log")
  })

  it("never trips while output keeps arriving, however long the total", async () => {
    const wd = startProvisionWatchdog({ stallTimeoutMs: 120, maxMs: 0 })
    for (let i = 0; i < 8; i++) {
      wd.output(`progress ${i}\n`)
      await sleep(40)
    }
    expect(wd.signal.aborted).toBe(false)
    wd.stop()
  })

  it("does not stall-trip in an unwatched (in-process) phase, but the hard cap still does", async () => {
    const wd = startProvisionWatchdog({ stallTimeoutMs: 50, maxMs: 200 })
    wd.phase("clone", false)
    await sleep(120)
    expect(wd.signal.aborted).toBe(false)
    await sleep(200)
    expect(wd.tripped()?.kind).toBe("max")
    expect(wd.tripped()?.message).toContain("provisioning cap")
  })
})

const candidates = [worktreeProvider]

describe("worktree.provision boot bounds (real git, real child processes)", () => {
  const cleanup: string[] = []
  let repoRoot: string
  let scratch: string

  const setupRepo = async (setup: string | ((scratch: string) => string)): Promise<void> => {
    repoRoot = await mkdtemp(join(tmpdir(), "wt-wd-repo-"))
    scratch = await mkdtemp(join(tmpdir(), "wt-wd-scratch-"))
    cleanup.push(repoRoot, scratch)
    if (typeof setup === "function") setup = setup(scratch)
    await execGit(repoRoot, ["init", "-b", "main"])
    await execGit(repoRoot, ["config", "user.email", "test@example.com"])
    await execGit(repoRoot, ["config", "user.name", "Test"])
    await writeFile(join(repoRoot, "agentproto.json"), JSON.stringify({ worktree: { setup } }))
    await execGit(repoRoot, ["add", "."])
    await execGit(repoRoot, ["commit", "-m", "init"])
  }

  afterEach(async () => {
    provisionScheduler.configure(DEFAULT_PROVISION_LIMITS)
    expect(provisionScheduler.snapshot()).toMatchObject({ running: 0, queued: 0 })
    while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
  })

  const provision = (ctx: Parameters<typeof runWithProvisionContext>[0]) =>
    runWithProvisionContext(ctx, () =>
      runTool({
        tool: provisionWorktreeTool,
        candidates,
        input: { repoRoot, base: "main", slug: "wd", dir: join(scratch, "wd") },
      }),
    )

  it("fails a setup hook that goes silent past the stall timeout, killing its process tree", { timeout: 30_000 }, async () => {
    await setupRepo(s => `echo starting; sh -c 'echo $$ > ${s}/pid; exec sleep 60'`)
    const out: string[] = []
    const started = Date.now()
    await expect(
      provision({ stallTimeoutMs: 600, maxMs: 0, onOutput: t => out.push(t) }),
    ).rejects.toThrow(/stalled in phase "setup": no output/)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(out.join("")).toContain("starting")
    const pid = Number((await readFile(join(scratch, "pid"), "utf8")).trim())
    expect(pid).toBeGreaterThan(0)
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
  })

  it("does not fail a slow setup hook that keeps printing past the stall timeout", { timeout: 30_000 }, async () => {
    await setupRepo(`for i in 1 2 3 4 5 6; do echo step $i; sleep 0.4; done`)
    const out: string[] = []
    const res = await provision({ stallTimeoutMs: 1_200, maxMs: 0, onOutput: t => out.push(t) })
    expect(res.branch).toBe("wt/wd")
    expect(out.join("")).toContain("step 6")
  })

  it("fails a chatty hook at the hard cap", { timeout: 30_000 }, async () => {
    await setupRepo(`while true; do echo tick; sleep 0.1; done`)
    await expect(provision({ stallTimeoutMs: 5_000, maxMs: 800 })).rejects.toThrow(
      /timed out in phase "setup": exceeded the/,
    )
  })

  it("runs unbounded when no bounds are passed (interactive callers)", { timeout: 30_000 }, async () => {
    await setupRepo(`sleep 1; echo done`)
    const res = await provision({})
    expect(res.branch).toBe("wt/wd")
  })
})

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runTool } from "@agentproto/driver"
import { provisionWorktreeTool } from "../tools/index.js"
import { worktreeProvider } from "../provider/worktree-provider.js"
import { execGit } from "../exec.js"
import {
  DEFAULT_PROVISION_LIMITS,
  ProvisionCancelledError,
  provisionScheduler,
  runWithProvisionContext,
  type ProvisionProgress,
} from "../provision-scheduler.js"

const candidates = [worktreeProvider]

async function makeTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "wt-queue-repo-"))
  await execGit(repoRoot, ["init", "-b", "main"])
  await execGit(repoRoot, ["config", "user.email", "test@example.com"])
  await execGit(repoRoot, ["config", "user.name", "Test"])
  await writeFile(join(repoRoot, "README.md"), "hello\n")
  await execGit(repoRoot, ["add", "."])
  await execGit(repoRoot, ["commit", "-m", "init"])
  return repoRoot
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  )

/** Script the fake installs run: logs `start:<tag>` / `end:<tag>` around a sleep. */
const DEP_SCRIPT = `const fs = require("node:fs")
const [log, tag, ms] = process.argv.slice(2)
fs.appendFileSync(log, "start:" + tag + "\\n")
setTimeout(() => fs.appendFileSync(log, "end:" + tag + "\\n"), Number(ms))
`

describe("worktree.provision through the daemon-wide scheduler (real git, real child processes)", () => {
  const cleanup: string[] = []
  let repoRoot: string
  let scratch: string
  let depScript: string
  /** A `depsCmd` that logs `start:<tag>` / `end:<tag>` around a short sleep. */
  const loggingDeps = (log: string, tag: string, ms = 150): string => `node ${depScript} ${log} ${tag} ${ms}`

  beforeEach(async () => {
    repoRoot = await makeTempRepo()
    scratch = await mkdtemp(join(tmpdir(), "wt-queue-scratch-"))
    cleanup.push(repoRoot, scratch)
    depScript = join(scratch, "dep.js")
    await writeFile(depScript, DEP_SCRIPT)
    provisionScheduler.configure({ ...DEFAULT_PROVISION_LIMITS, concurrency: 1 })
  })

  afterEach(async () => {
    provisionScheduler.configure(DEFAULT_PROVISION_LIMITS)
    expect(provisionScheduler.snapshot()).toMatchObject({ running: 0, queued: 0 })
    while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
  })

  const provision = (
    slug: string,
    depsCmd: string | undefined,
    ctx: Parameters<typeof runWithProvisionContext>[0] = {},
  ) =>
    runWithProvisionContext(ctx, () =>
      runTool({
        tool: provisionWorktreeTool,
        candidates,
        input: {
          repoRoot,
          base: "main",
          slug,
          dir: join(scratch, slug),
          ...(depsCmd ? { depsCmd } : {}),
        },
      }),
    )

  it("runs heavy phases one at a time when the cap is 1, in arrival order", async () => {
    const log = join(scratch, "log.txt")
    const all = ["a", "b", "c"].map((tag, i) =>
      // Stagger the arrivals so the FIFO order is deterministic.
      new Promise<void>(r => setTimeout(r, i * 250)).then(() => provision(tag, loggingDeps(log, tag))),
    )
    await Promise.all(all)
    const lines = (await readFile(log, "utf8")).trim().split("\n")
    expect(lines).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"])
  })

  it("does not queue a provisioning that has no heavy phase", async () => {
    const holder = new AbortController()
    const hold = provision("holder", `node -e "setTimeout(()=>{},60000)"`, { signal: holder.signal }).catch(() => {})
    await vi.waitFor(() => expect(provisionScheduler.snapshot().running).toBe(1))
    const progress: ProvisionProgress[] = []
    const cheap = await provision("cheap", undefined, { onProgress: p => progress.push(p) })
    expect(cheap.branch).toBe("wt/cheap")
    expect(progress).toEqual([{ kind: "done", outcome: "ok" }])
    holder.abort()
    await hold
  })

  it("reports queued -> started -> phase -> done in order", async () => {
    const log = join(scratch, "log.txt")
    const holder = new AbortController()
    const first = provision("first", `node -e "setTimeout(()=>{},60000)"`, { signal: holder.signal })
    const firstSettled = first.catch((err: unknown) => err)
    await vi.waitFor(() => expect(provisionScheduler.snapshot().running).toBe(1))
    const progress: ProvisionProgress[] = []
    const second = provision("second", loggingDeps(log, "second", 10), { onProgress: p => progress.push(p) })
    // Release the slot only once the second one is genuinely waiting for it.
    await vi.waitFor(() => expect(progress).toEqual([{ kind: "queued", position: 1, phase: "deps" }]))
    holder.abort()
    await Promise.all([second, firstSettled])
    expect(progress).toEqual([
      { kind: "queued", position: 1, phase: "deps" },
      { kind: "started", phase: "deps" },
      { kind: "phase", phase: "deps" },
      { kind: "done", outcome: "ok" },
    ])
  })

  it("cancelling while queued drops the entry, rejects, and removes the half-made worktree and branch", async () => {
    const log = join(scratch, "log.txt")
    const holder = provision("holder", loggingDeps(log, "holder", 1500))
    await vi.waitFor(() => expect(provisionScheduler.snapshot().running).toBe(1))

    const ac = new AbortController()
    const progress: ProvisionProgress[] = []
    const queued = provision("queued", loggingDeps(log, "queued"), {
      signal: ac.signal,
      onProgress: p => progress.push(p),
    })
    await vi.waitFor(() => expect(provisionScheduler.snapshot().queued).toBe(1))
    ac.abort()
    await expect(queued).rejects.toBeInstanceOf(ProvisionCancelledError)

    expect(provisionScheduler.snapshot().queued).toBe(0)
    expect(progress.at(-1)).toEqual({ kind: "done", outcome: "cancelled" })
    // The cancelled spawn never ran its install ...
    await holder
    expect(await readFile(log, "utf8")).not.toContain("queued")
    // ... and left no worktree or branch behind.
    expect(await exists(join(scratch, "queued"))).toBe(false)
    const branches = (await execGit(repoRoot, ["branch", "--list", "wt/queued"])).stdout
    expect(branches.trim()).toBe("")
    // The running one was unaffected.
    expect(await exists(join(scratch, "holder"))).toBe(true)
  })

  it("cancelling while running kills the install's whole process tree (no orphaned grandchildren)", async () => {
    const pidFile = join(scratch, "grandchild.pid")
    // sh -> (sleep 300 in the background) ; wait. The sleep is a grandchild of
    // the provisioning's spawned shell: only a process-group kill reaches it.
    const depsCmd = `sh -c 'sleep 300 & echo $! > ${pidFile}; wait'`
    const ac = new AbortController()
    const progress: ProvisionProgress[] = []
    const running = provision("running", depsCmd, { signal: ac.signal, onProgress: p => progress.push(p) })
    // Observe the rejection early so an unhandled-rejection never races the assertions.
    const settled = running.then(
      () => "resolved",
      (err: unknown) => err,
    )

    await vi.waitFor(async () => expect(await exists(pidFile)).toBe(true), { timeout: 15_000 })
    const grandchild = Number((await readFile(pidFile, "utf8")).trim())
    expect(Number.isInteger(grandchild)).toBe(true)
    expect(isAlive(grandchild)).toBe(true)

    ac.abort()
    const outcome = await settled
    expect(outcome).toBeInstanceOf(ProvisionCancelledError)
    await vi.waitFor(() => expect(isAlive(grandchild)).toBe(false), { timeout: 15_000 })

    expect(provisionScheduler.snapshot()).toMatchObject({ running: 0, queued: 0 })
    expect(progress).toContainEqual({ kind: "started", phase: "deps" })
    expect(progress.at(-1)).toEqual({ kind: "done", outcome: "cancelled" })
    expect(await exists(join(scratch, "running"))).toBe(false)
  }, 30_000)

  it("frees the slot when a running provisioning is cancelled, so the next queued one starts", async () => {
    const log = join(scratch, "log.txt")
    const ac = new AbortController()
    const first = provision("first", `node -e "setTimeout(()=>{},60000)"`, { signal: ac.signal })
    const firstSettled = first.catch((err: unknown) => err)
    await vi.waitFor(() => expect(provisionScheduler.snapshot().running).toBe(1))
    const second = provision("second", loggingDeps(log, "second", 10))
    await vi.waitFor(() => expect(provisionScheduler.snapshot().queued).toBe(1))
    ac.abort()
    expect(await firstSettled).toBeInstanceOf(ProvisionCancelledError)
    await second
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["start:second", "end:second"])
  }, 30_000)

  it("a failing install is a plain failure (worktree kept for inspection) and still frees its slot", async () => {
    await expect(provision("broken", `node -e "process.exit(3)"`)).rejects.toThrow(/depsCmd .* failed \(exit 3\)/)
    expect(provisionScheduler.snapshot().running).toBe(0)
    expect(await exists(join(scratch, "broken"))).toBe(true)
  })

  it("an already-aborted signal never starts the install", async () => {
    const marker = join(scratch, "ran.txt")
    const ac = new AbortController()
    ac.abort()
    await expect(
      provision("aborted", `touch ${marker}`, {
        signal: ac.signal,
      }),
    ).rejects.toBeInstanceOf(ProvisionCancelledError)
    expect(await exists(marker)).toBe(false)
    expect(provisionScheduler.snapshot()).toMatchObject({ running: 0, queued: 0 })
  })
})

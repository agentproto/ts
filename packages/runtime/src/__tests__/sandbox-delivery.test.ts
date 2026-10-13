/**
 * Teardown delivery of a sandbox session's work branch: the pure decisions,
 * the generated commands, and the runner against a fake `exec`/`readFile` and a
 * temp host directory. No box, no git, no network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxExecOpts, SandboxExecResult } from "@agentproto/sandbox"

import {
  DELIVERY_BUNDLE_FILE,
  DELIVERY_RECORD_FILE,
  buildBundleCommand,
  buildProbeCommand,
  buildCheckpointPushCommand,
  buildCheckpointDeleteCommand,
  buildPushCommand,
  checkpointBranchOf,
  CHECKPOINT_BUNDLE_FILE,
  CHECKPOINT_RECORD_FILE,
  CHECKPOINT_REF_ABSENT_MARKER,
  createSandboxCheckpointer,
  decideBundle,
  isFullyDelivered,
  resolveCheckpointIntervalMs,
  resolveSandboxCheckpointConfig,
  sandboxCheckpointOpts,
  formatDeliveryNotice,
  formatUncommittedRescueNotice,
  parseProbe,
  runSandboxDelivery,
  shouldPush,
  withinBundleLimit,
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_CHECKPOINT_DEADLINE_MS,
  CHECKPOINT_BRANCH_PREFIX,
  type SandboxDeliveryRecord,
  type SandboxDeliveryTarget,
} from "../sandbox-delivery.js"

const FAKE_TOKEN = "ghp_fake_delivery_token_0004"
const target: SandboxDeliveryTarget = {
  checkoutDir: "/home/user/agentproto",
  branch: "wt/x",
  baseSha: "b".repeat(40),
}

function result(exitCode: number, stdout = "", stderr = ""): SandboxExecResult {
  return { exitCode, stdout, stderr, durationMs: 1 }
}

describe("delivery decisions", () => {
  it("pushes only a branch that is ahead of its base", () => {
    expect(shouldPush({ ahead: 0, uncommitted: 3 })).toBe(false)
    expect(shouldPush({ ahead: 2, uncommitted: 0 })).toBe(true)
  })

  it("bundles only commits that did not reach the remote, and only when the provider can download", () => {
    expect(decideBundle({ ahead: 0, pushStatus: "skipped", canDownload: true })).toMatchObject({ action: "skip" })
    expect(decideBundle({ ahead: 2, pushStatus: "pushed", canDownload: true })).toMatchObject({ action: "skip" })
    expect(decideBundle({ ahead: 2, pushStatus: "failed", canDownload: true })).toEqual({ action: "bundle" })
    expect(decideBundle({ ahead: 2, pushStatus: "failed", canDownload: false })).toMatchObject({ action: "skip" })
  })

  it("enforces the bundle size limit inclusively and rejects nonsense sizes", () => {
    expect(withinBundleLimit(100, 100)).toBe(true)
    expect(withinBundleLimit(101, 100)).toBe(false)
    expect(withinBundleLimit(Number.NaN, 100)).toBe(false)
    expect(withinBundleLimit(-1, 100)).toBe(false)
  })

  it("parses the probe output and rejects output without an ahead count", () => {
    expect(parseProbe("ahead=3\nuncommitted=2\n")).toEqual({ ahead: 3, uncommitted: 2 })
    expect(parseProbe("ahead=0\n")).toEqual({ ahead: 0, uncommitted: 0 })
    expect(parseProbe("fatal: bad revision")).toBeUndefined()
  })
})

describe("delivery commands", () => {
  it("quote the checkout, branch and base, and carry no credential", () => {
    const commands = [buildProbeCommand(target), buildPushCommand(target), buildBundleCommand(target)]
    expect(commands[0]).toContain(`'${target.baseSha}..refs/heads/wt/x'`)
    expect(commands[1]).toBe("git -C '/home/user/agentproto' push -u origin 'wt/x'")
    expect(commands[2]).toContain(`'${target.baseSha}..wt/x'`)
    for (const command of commands) {
      expect(command).not.toContain(FAKE_TOKEN)
      expect(command).not.toMatch(/https?:\/\//)
    }
  })
})

describe("runSandboxDelivery", () => {
  let outDir: string
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "agentproto-delivery-test-"))
  })
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  function fakeBox(opts: { ahead: number; pushExit?: number; bundleBytes?: number }) {
    const commands: SandboxExecOpts[] = []
    const exec = async (o: SandboxExecOpts): Promise<SandboxExecResult> => {
      commands.push(o)
      if (o.command.includes("rev-list")) return result(0, `ahead=${opts.ahead}\nuncommitted=1\n`)
      if (o.command.includes(" push ")) {
        return opts.pushExit ? result(opts.pushExit, "", "remote: Permission denied") : result(0)
      }
      if (o.command.includes("bundle create")) return result(0, `${opts.bundleBytes ?? 4}\n`)
      return result(1, "", "unexpected command")
    }
    return { exec, commands }
  }

  it("gives up on a hung box at the overall deadline and still records it", async () => {
    const exec = () => new Promise<SandboxExecResult>(() => undefined)
    const started = Date.now()
    const record = await runSandboxDelivery({ exec, target, outDir, deadlineMs: 50 })

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(record.push.status).toBe("failed")
    expect(record.push.detail).toMatch(/deadline/)
    const persisted = JSON.parse(await readFile(join(outDir, DELIVERY_RECORD_FILE), "utf8"))
    expect(persisted.push.status).toBe("failed")
  })

  it("caps each step's exec timeout by what is left of the deadline", async () => {
    const timeouts: Array<number | undefined> = []
    const exec = async (opts: SandboxExecOpts): Promise<SandboxExecResult> => {
      timeouts.push(opts.timeoutMs)
      return result(0, "ahead=0\nuncommitted=0\n")
    }
    await runSandboxDelivery({ exec, target, outDir, deadlineMs: 5_000 })

    // probe + the stale-checkpoint delete of a clean, safe teardown.
    expect(timeouts).toHaveLength(2)
    for (const timeoutMs of timeouts) expect(timeoutMs).toBeLessThanOrEqual(5_000)
  })

  it("keeps a slice of the deadline for the bundle when the push hangs", async () => {
    const commands: SandboxExecOpts[] = []
    const exec = async (o: SandboxExecOpts): Promise<SandboxExecResult> => {
      commands.push(o)
      if (o.command.includes("rev-list")) return result(0, "ahead=2\nuncommitted=0\n")
      if (o.command.includes(" push ")) return new Promise<SandboxExecResult>(() => undefined)
      if (o.command.includes("bundle create")) return result(0, "4\n")
      return result(1, "", "unexpected command")
    }
    const record = await runSandboxDelivery({
      exec,
      readFile: async () => new Uint8Array([1, 2, 3, 4]),
      target,
      outDir,
      deadlineMs: 1_500,
      bundleReserveMs: 1_000,
    })

    expect(record.push.status).toBe("failed")
    const push = commands.find(c => c.command.includes(" push "))
    expect(push?.timeoutMs).toBeLessThanOrEqual(500)
    expect(record.bundle.status).toBe("saved")
    expect(await readFile(join(outDir, DELIVERY_BUNDLE_FILE))).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it("pushes an ahead branch and skips the bundle", async () => {
    const box = fakeBox({ ahead: 2 })
    const record = await runSandboxDelivery({ exec: box.exec, readFile: async () => new Uint8Array(), target, outDir })
    expect(record.push).toEqual({ status: "pushed" })
    expect(record.bundle.status).toBe("skipped")
    expect(record.ahead).toBe(2)
    expect(record.uncommittedFiles).toBe(1)
    expect(box.commands.some(c => c.command.includes("bundle create"))).toBe(false)
    const persisted = JSON.parse(await readFile(join(outDir, DELIVERY_RECORD_FILE), "utf8"))
    expect(persisted.push.status).toBe("pushed")
  })

  it("skips the push and bundle when no commits are ahead of base, but still cleans up a stale checkpoint", async () => {
    const box = fakeBox({ ahead: 0 })
    const record = await runSandboxDelivery({ exec: box.exec, readFile: async () => new Uint8Array(), target, outDir })
    expect(record.push.status).toBe("skipped")
    expect(record.bundle.status).toBe("skipped")
    // Teardown of a clean, safe worktree always tries the checkpoint delete.
    expect(record.checkpointCleanup).toEqual({ status: "deleted", ref: "agentproto-checkpoint/wt/x" })
    expect(box.commands).toHaveLength(2)
    expect(box.commands[1]?.command).toContain("push origin --delete")
  })

  it("falls back to a bundle saved on the host when the push fails", async () => {
    const box = fakeBox({ ahead: 2, pushExit: 128, bundleBytes: 4 })
    const bytes = new Uint8Array([1, 2, 3, 4])
    const paths: string[] = []
    const record = await runSandboxDelivery({
      exec: box.exec,
      readFile: async path => {
        paths.push(path)
        return bytes
      },
      target,
      outDir,
    })
    expect(record.push.status).toBe("failed")
    expect(record.push.detail).toContain("Permission denied")
    expect(record.bundle).toEqual({ status: "saved", path: join(outDir, DELIVERY_BUNDLE_FILE), bytes: 4 })
    expect(paths).toEqual(["/tmp/agentproto-delivery.bundle"])
    expect(new Uint8Array(await readFile(join(outDir, DELIVERY_BUNDLE_FILE)))).toEqual(bytes)
  })

  it("leaves an oversized bundle in the box and reports it", async () => {
    const box = fakeBox({ ahead: 1, pushExit: 1, bundleBytes: 500 })
    let downloaded = false
    const record = await runSandboxDelivery({
      exec: box.exec,
      readFile: async () => {
        downloaded = true
        return new Uint8Array()
      },
      target,
      outDir,
      maxBytes: 100,
    })
    expect(downloaded).toBe(false)
    expect(record.bundle.status).toBe("skipped")
    expect(record.bundle.detail).toContain("over the 100 byte limit")
  })

  it("reports a provider that cannot download instead of attempting a bundle", async () => {
    const box = fakeBox({ ahead: 1, pushExit: 1 })
    const record = await runSandboxDelivery({ exec: box.exec, target, outDir })
    expect(record.bundle).toMatchObject({ status: "skipped", detail: "provider cannot download files from the box" })
    expect(box.commands.some(c => c.command.includes("bundle create"))).toBe(false)
  })

  it("never throws: a dead box yields a failed record", async () => {
    const record = await runSandboxDelivery({
      exec: async () => {
        throw new Error("sandbox is gone")
      },
      target,
      outDir,
    })
    expect(record.push.status).toBe("failed")
    expect(record.push.detail).toContain("sandbox is gone")
    expect(record.ahead).toBeUndefined()
  })

  it("summarises the outcome for the transcript", async () => {
    const box = fakeBox({ ahead: 2, pushExit: 128 })
    const record = await runSandboxDelivery({ exec: box.exec, readFile: async () => new Uint8Array(4), target, outDir })
    const notice = formatDeliveryNotice(record)
    expect(notice).toContain("wt/x")
    expect(notice).toContain("2 commit(s) ahead of bbbbbbb")
    expect(notice).toContain("push: failed")
    expect(notice).toContain("bundle: saved")
    expect(notice).toContain("1 uncommitted file(s) NOT delivered")
  })
})

const HEAD = "a".repeat(40)
const SNAP = "d".repeat(40)
const TREE = "e".repeat(40)

describe("uncommitted-work snapshot", () => {
  let outDir: string
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "agentproto-checkpoint-test-"))
  })
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  function snapshotBox(opts: { ahead: number; tree?: string; pushExit?: number; checkpointPushExit?: number }) {
    const commands: SandboxExecOpts[] = []
    const exec = async (o: SandboxExecOpts): Promise<SandboxExecResult> => {
      commands.push(o)
      if (o.command.includes("rev-list")) {
        return result(
          0,
          `ahead=${opts.ahead}\nuncommitted=2\nhead=${HEAD}\nsnapshot=${SNAP}\ntree=${opts.tree ?? TREE}\n`,
        )
      }
      if (o.command.includes("refs/agentproto/checkpoint:")) {
        return opts.checkpointPushExit ? result(opts.checkpointPushExit, "", "rejected") : result(0)
      }
      if (o.command.includes(" push ")) return opts.pushExit ? result(opts.pushExit, "", "denied") : result(0)
      if (o.command.includes("bundle create")) return result(0, "4\n")
      return result(1, "", "unexpected command")
    }
    return { exec, commands }
  }

  it("parses the snapshot and keys it on content, not on the commit sha", () => {
    expect(parseProbe(`ahead=1\nuncommitted=2\nhead=${HEAD}\nsnapshot=${SNAP}\ntree=${TREE}\n`)).toEqual({
      ahead: 1,
      uncommitted: 2,
      head: HEAD,
      snapshot: SNAP,
      snapshotTree: TREE,
    })
    // A failed snapshot is reported, never mistaken for one.
    expect(parseProbe(`ahead=1\nuncommitted=2\nhead=${HEAD}\nsnapshot=failed\n`)?.snapshot).toBeUndefined()
  })

  it("snapshots through a throwaway index and never touches the agent's own", () => {
    const probe = buildProbeCommand(target)
    expect(probe).toContain('GIT_INDEX_FILE="$idx" git add -A')
    expect(probe).toContain("git update-ref refs/agentproto/checkpoint")
    expect(probe).not.toMatch(/git (stash|reset|checkout|commit )/)
    expect(probe.match(/git add/g)).toHaveLength(1)
    expect(buildCheckpointPushCommand(target)).toBe(
      "git -C '/home/user/agentproto' push origin '+refs/agentproto/checkpoint:refs/heads/agentproto-checkpoint/wt/x'",
    )
  })

  it("pushes uncommitted work even with no commits ahead, and stops reporting it as lost", async () => {
    const box = snapshotBox({ ahead: 0 })
    const record = await runSandboxDelivery({ exec: box.exec, target, outDir })
    expect(record.push.status).toBe("skipped")
    expect(record.checkpoint).toEqual({
      status: "pushed",
      ref: "agentproto-checkpoint/wt/x",
      sha: SNAP,
    })
    expect(record.bundle.status).toBe("skipped")
    expect(formatDeliveryNotice(record)).not.toContain("NOT delivered")
    expect(box.commands.find(c => c.command.includes("rev-list"))?.env).toMatchObject({ GIT_OPTIONAL_LOCKS: "0" })
  })

  it("bundles up to the snapshot when its push fails", async () => {
    const box = snapshotBox({ ahead: 1, checkpointPushExit: 1 })
    const record = await runSandboxDelivery({
      exec: box.exec,
      readFile: async () => new Uint8Array([9, 9, 9, 9]),
      target,
      outDir,
      mode: "checkpoint",
    })
    expect(record.push.status).toBe("pushed")
    expect(record.checkpoint?.status).toBe("failed")
    expect(record.bundle).toMatchObject({ status: "saved", path: join(outDir, CHECKPOINT_BUNDLE_FILE) })
    const bundle = box.commands.find(c => c.command.includes("bundle create"))?.command ?? ""
    expect(bundle).toContain(`'${target.baseSha}..refs/agentproto/checkpoint'`)
    expect(bundle).toContain("/tmp/agentproto-checkpoint.bundle")
    const persisted = JSON.parse(await readFile(join(outDir, CHECKPOINT_RECORD_FILE), "utf8"))
    expect(persisted.mode).toBe("checkpoint")
    expect(formatDeliveryNotice(record)).toMatch(/^\[sandbox checkpoint\]/)
  })

  it("a checkpointer skips the pushes while nothing changed, and retries after a failure", async () => {
    let tree = TREE
    let checkpointPushExit = 1
    const commands: string[] = []
    const exec = async (o: SandboxExecOpts): Promise<SandboxExecResult> => {
      commands.push(o.command)
      if (o.command.includes("rev-list")) {
        return result(0, `ahead=0\nuncommitted=1\nhead=${HEAD}\nsnapshot=${SNAP}\ntree=${tree}\n`)
      }
      if (o.command.includes(" push ")) return result(checkpointPushExit)
      return result(1)
    }
    const seen: string[] = []
    const checkpointer = createSandboxCheckpointer({
      exec,
      target,
      outDir,
      onCheckpoint: r => seen.push(r.checkpoint?.status ?? (r.unchanged ? "unchanged" : "none")),
    })
    await checkpointer.run()
    checkpointPushExit = 0
    await checkpointer.run() // the failed push is retried, not skipped
    await checkpointer.run() // now unchanged
    tree = "f".repeat(40)
    await checkpointer.run() // new content
    expect(seen).toEqual(["failed", "pushed", "unchanged", "pushed"])
    expect(commands.filter(c => c.includes(" push ")).length).toBe(3)
  })

  it("concurrent checkpoint runs share one in-flight run", async () => {
    let probes = 0
    const exec = async (o: SandboxExecOpts): Promise<SandboxExecResult> => {
      if (o.command.includes("rev-list")) {
        probes++
        await new Promise(resolve => setTimeout(resolve, 20))
        return result(0, "ahead=0\nuncommitted=0\n")
      }
      return result(1)
    }
    const checkpointer = createSandboxCheckpointer({ exec, target, outDir })
    await Promise.all([checkpointer.run(), checkpointer.run(), checkpointer.run()])
    expect(probes).toBe(1)
  })

  it("isFullyDelivered: pushed, bundled, or nothing to deliver", () => {
    const base = { at: "t", branch: "wt/x", baseSha: target.baseSha, key: "k" }
    expect(isFullyDelivered({ ...base, ahead: 0, push: { status: "skipped" }, bundle: { status: "skipped" } })).toBe(true)
    expect(isFullyDelivered({ ...base, ahead: 2, push: { status: "failed" }, bundle: { status: "skipped" } })).toBe(false)
    expect(isFullyDelivered({ ...base, ahead: 2, push: { status: "failed" }, bundle: { status: "saved" } })).toBe(true)
    expect(
      isFullyDelivered({
        ...base,
        ahead: 0,
        push: { status: "skipped" },
        checkpoint: { status: "failed", ref: "r" },
        bundle: { status: "skipped" },
      }),
    ).toBe(false)
    const { key: _key, ...noKey } = base
    expect(isFullyDelivered({ ...noKey, push: { status: "failed" }, bundle: { status: "skipped" } })).toBe(false)
  })

  it("resolves the checkpoint interval from the env, 0 turning it off", () => {
    expect(resolveCheckpointIntervalMs({})).toBe(5 * 60_000)
    expect(resolveCheckpointIntervalMs({ AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS: "60000" })).toBe(60_000)
    expect(resolveCheckpointIntervalMs({ AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS: "0" })).toBe(0)
    expect(resolveCheckpointIntervalMs({ AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS: "soon" })).toBe(5 * 60_000)
  })

  it("stamps the turn number onto the snapshot commit message and the record", async () => {
    const box = snapshotBox({ ahead: 0 })
    const record = await runSandboxDelivery({ exec: box.exec, target, outDir, turn: 7 })
    expect(record.turn).toBe(7)
    const probe = box.commands.find(c => c.command.includes("rev-list"))?.command ?? ""
    expect(probe).toContain("agentproto checkpoint: uncommitted work on wt/x turn 7")
  })

  it("a checkpointer stamps whichever turn started the coalesced run", async () => {
    const box = snapshotBox({ ahead: 0 })
    const checkpointer = createSandboxCheckpointer({ exec: box.exec, target, outDir })
    const [a, b] = await Promise.all([checkpointer.run(3), checkpointer.run(99)])
    expect(a.turn).toBe(3)
    expect(b.turn).toBe(3)
  })

  it("skips the snapshot entirely when snapshotUncommitted is false — count only, like teardown before checkpoints existed", async () => {
    const commands: SandboxExecOpts[] = []
    const exec = async (o: SandboxExecOpts): Promise<SandboxExecResult> => {
      commands.push(o)
      return result(0, `ahead=0\nuncommitted=3\nhead=${HEAD}\n`)
    }
    const record = await runSandboxDelivery({ exec, target, outDir, snapshotUncommitted: false })
    expect(record.uncommittedFiles).toBe(3)
    expect(record.checkpoint).toBeUndefined()
    const probe = commands[0]!.command
    expect(probe).not.toContain("git commit-tree")
    expect(probe).not.toContain("GIT_INDEX_FILE")
    // Clean, nothing ahead, teardown: the stale-checkpoint delete still runs.
    expect(record.checkpointCleanup).toEqual({ status: "deleted", ref: "agentproto-checkpoint/wt/x" })
  })

  it("buildProbeCommand with snapshotUncommitted:false drops the snapshot subshell but keeps the counts", () => {
    const full = buildProbeCommand(target)
    const countOnly = buildProbeCommand(target, { snapshotUncommitted: false })
    expect(full).toContain("git commit-tree")
    expect(countOnly).not.toContain("git commit-tree")
    expect(countOnly).toContain("uncommitted=$n")
    expect(countOnly).toContain("head=$(git rev-parse HEAD)")
  })

  it("checkpointBranchOf/buildCheckpointPushCommand take a custom refPrefix, defaulting to the legacy one", () => {
    expect(checkpointBranchOf("wt/x")).toBe("agentproto-checkpoint/wt/x")
    expect(checkpointBranchOf("wt/x", "custom/")).toBe("custom/wt/x")
    expect(buildCheckpointPushCommand(target, "custom/")).toBe(
      "git -C '/home/user/agentproto' push origin '+refs/agentproto/checkpoint:refs/heads/custom/wt/x'",
    )
  })

  it("buildCheckpointDeleteCommand deletes the checkpoint ref, quoting both, and treats a missing ref as success", () => {
    expect(buildCheckpointDeleteCommand(target)).toBe(
      "git -C '/home/user/agentproto' push origin --delete 'agentproto-checkpoint/wt/x' 2>&1 || " +
        "{ git ls-remote --exit-code origin 'refs/heads/agentproto-checkpoint/wt/x' >/dev/null; " +
        "test $? -eq 2 && echo checkpoint-ref-absent; }",
    )
    expect(buildCheckpointDeleteCommand(target, "custom/")).toBe(
      "git -C '/home/user/agentproto' push origin --delete 'custom/wt/x' 2>&1 || " +
        "{ git ls-remote --exit-code origin 'refs/heads/custom/wt/x' >/dev/null; " +
        "test $? -eq 2 && echo checkpoint-ref-absent; }",
    )
  })

  it("pushes the checkpoint snapshot to a custom refPrefix end to end", async () => {
    const box = snapshotBox({ ahead: 0 })
    const record = await runSandboxDelivery({ exec: box.exec, target, outDir, refPrefix: "custom/" })
    expect(record.checkpoint).toMatchObject({ status: "pushed", ref: "custom/wt/x" })
    const push = box.commands.find(c => c.command.includes("refs/agentproto/checkpoint:"))?.command ?? ""
    expect(push).toContain("refs/heads/custom/wt/x")
  })
})

describe("checkpoint cleanup", () => {
  let outDir: string
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "agentproto-checkpoint-cleanup-"))
  })
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  /** Clean checkout (no snapshot), optional push outcome and delete outcome. */
  function cleanBox(opts: { ahead: number; pushExit?: number; deleteExit?: number; deleteStdout?: string }) {
    const commands: SandboxExecOpts[] = []
    const exec = async (o: SandboxExecOpts): Promise<SandboxExecResult> => {
      commands.push(o)
      if (o.command.includes("rev-list")) return result(0, `ahead=${opts.ahead}\nuncommitted=0\nhead=${HEAD}\n`)
      if (o.command.includes("--delete")) {
        return result(opts.deleteExit ?? 0, opts.deleteStdout ?? "", opts.deleteExit ? "rejected" : "")
      }
      if (o.command.includes(" push ")) return opts.pushExit ? result(opts.pushExit, "", "denied") : result(0)
      return result(1, "", "unexpected command")
    }
    return { exec, commands }
  }

  it("teardown, clean tree, branch pushed: deletes the checkpoint branch", async () => {
    const box = cleanBox({ ahead: 2 })
    const record = await runSandboxDelivery({ exec: box.exec, target, outDir })
    expect(record.push.status).toBe("pushed")
    expect(record.checkpointCleanup).toEqual({ status: "deleted", ref: "agentproto-checkpoint/wt/x" })
    const deleteCmd = box.commands.find(c => c.command.includes("--delete"))?.command ?? ""
    expect(deleteCmd).toContain("push origin --delete 'agentproto-checkpoint/wt/x'")
    expect(formatDeliveryNotice(record)).toContain("checkpoint cleanup: deleted")
  })

  it("teardown, the ref is already gone: absent, not a failure", async () => {
    const box = cleanBox({ ahead: 2, deleteStdout: `${CHECKPOINT_REF_ABSENT_MARKER}\n` })
    const record = await runSandboxDelivery({ exec: box.exec, target, outDir })
    expect(record.checkpointCleanup).toEqual({ status: "absent", ref: "agentproto-checkpoint/wt/x" })
  })

  it("a failing delete is recorded, never thrown", async () => {
    const box = cleanBox({ ahead: 2, deleteExit: 128 })
    const record = await runSandboxDelivery({ exec: box.exec, target, outDir })
    expect(record.checkpointCleanup).toMatchObject({ status: "failed", ref: "agentproto-checkpoint/wt/x" })
    expect(record.checkpointCleanup?.detail).toContain("exit 128")
    expect(record.push.status).toBe("pushed")
  })

  it("a snapshot this run means the checkpoint is still needed: no delete", async () => {
    const commands: SandboxExecOpts[] = []
    const exec = async (o: SandboxExecOpts): Promise<SandboxExecResult> => {
      commands.push(o)
      if (o.command.includes("rev-list")) {
        return result(0, `ahead=2\nuncommitted=1\nhead=${HEAD}\nsnapshot=${SNAP}\ntree=${TREE}\n`)
      }
      if (o.command.includes(" push ")) return result(0)
      return result(1, "", "unexpected command")
    }
    const record = await runSandboxDelivery({ exec, target, outDir })
    expect(record.checkpoint?.status).toBe("pushed")
    expect(record.checkpointCleanup).toBeUndefined()
    expect(commands.some(c => c.command.includes("--delete"))).toBe(false)
  })

  it("a failed branch push means the checkpoint may be the only copy: no delete", async () => {
    const box = cleanBox({ ahead: 2, pushExit: 128 })
    const record = await runSandboxDelivery({ exec: box.exec, readFile: async () => new Uint8Array(4), target, outDir })
    expect(record.push.status).toBe("failed")
    expect(record.checkpointCleanup).toBeUndefined()
    expect(box.commands.some(c => c.command.includes("--delete"))).toBe(false)
  })

  it("checkpoint mode only deletes when a checkpoint was pushed earlier in the session", async () => {
    const idle = cleanBox({ ahead: 1 })
    const without = await runSandboxDelivery({ exec: idle.exec, target, outDir, mode: "checkpoint", checkpointPushed: false })
    expect(without.checkpointCleanup).toBeUndefined()
    expect(idle.commands.some(c => c.command.includes("--delete"))).toBe(false)

    const active = cleanBox({ ahead: 1 })
    const withPrior = await runSandboxDelivery({ exec: active.exec, target, outDir, mode: "checkpoint", checkpointPushed: true })
    expect(withPrior.checkpointCleanup).toEqual({ status: "deleted", ref: "agentproto-checkpoint/wt/x" })
  })

  it("clean tree, nothing ahead, a prior checkpoint push: the delete still happens on the early-return path", async () => {
    const box = cleanBox({ ahead: 0 })
    const record = await runSandboxDelivery({ exec: box.exec, target, outDir, mode: "checkpoint", checkpointPushed: true })
    expect(record.push.status).toBe("skipped")
    expect(record.bundle.status).toBe("skipped")
    expect(record.checkpointCleanup).toEqual({ status: "deleted", ref: "agentproto-checkpoint/wt/x" })
  })

  it("a checkpointer tracks checkpointPushed across records and passes it to later runs", async () => {
    let dirty = true
    const commands: string[] = []
    const exec = async (o: SandboxExecOpts): Promise<SandboxExecResult> => {
      commands.push(o.command)
      if (o.command.includes("rev-list")) {
        return dirty
          ? result(0, `ahead=0\nuncommitted=1\nhead=${HEAD}\nsnapshot=${SNAP}\ntree=${TREE}\n`)
          : result(0, "ahead=0\nuncommitted=0\n")
      }
      return result(0)
    }
    const checkpointer = createSandboxCheckpointer({ exec, target, outDir })
    await checkpointer.run() // pushes a checkpoint
    dirty = false
    const record = await checkpointer.run() // clean now: the prior checkpoint is stale
    expect(record.checkpointCleanup).toEqual({ status: "deleted", ref: "agentproto-checkpoint/wt/x" })
    expect(commands.some(c => c.includes("--delete"))).toBe(true)
  })
})

describe("resolveSandboxCheckpointConfig", () => {
  it("defaults to enabled, both triggers, the legacy ref prefix, and the env-derived interval", () => {
    const resolved = resolveSandboxCheckpointConfig(undefined, undefined, {})
    expect(resolved).toEqual({
      enabled: true,
      onTurnEnd: true,
      onTeardown: true,
      refPrefix: CHECKPOINT_BRANCH_PREFIX,
      minIntervalMs: DEFAULT_CHECKPOINT_INTERVAL_MS,
      timeoutMs: DEFAULT_CHECKPOINT_DEADLINE_MS,
    })
  })

  it("falls back to the legacy env var only when neither config layer sets minIntervalMs", () => {
    const env = { AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS: "90000" }
    expect(resolveSandboxCheckpointConfig(undefined, undefined, env).minIntervalMs).toBe(90_000)
    expect(resolveSandboxCheckpointConfig({ minIntervalMs: 1_000 }, undefined, env).minIntervalMs).toBe(1_000)
    expect(resolveSandboxCheckpointConfig(undefined, { minIntervalMs: 2_000 }, env).minIntervalMs).toBe(2_000)
  })

  it("minIntervalMs <= 0 disables turn-end checkpoints, same as the legacy env off-switch", () => {
    expect(resolveSandboxCheckpointConfig({ minIntervalMs: 0 }, undefined, {}).onTurnEnd).toBe(false)
    expect(resolveSandboxCheckpointConfig(undefined, undefined, { AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS: "0" }).onTurnEnd).toBe(
      false,
    )
  })

  it("per-spawn wins key-by-key over the global default", () => {
    const resolved = resolveSandboxCheckpointConfig(
      { on: ["turn-end", "teardown"], refPrefix: "global/", minIntervalMs: 10_000 },
      { on: ["turn-end"], timeoutMs: 5_000 },
      {},
    )
    expect(resolved.onTurnEnd).toBe(true)
    expect(resolved.onTeardown).toBe(false)
    expect(resolved.refPrefix).toBe("global/")
    expect(resolved.minIntervalMs).toBe(10_000)
    expect(resolved.timeoutMs).toBe(5_000)
  })

  it("per-spawn false disables both triggers for this spawn regardless of the global config", () => {
    const resolved = resolveSandboxCheckpointConfig({ enabled: true, on: ["turn-end", "teardown"] }, false, {})
    expect(resolved.enabled).toBe(false)
    expect(resolved.onTurnEnd).toBe(false)
    expect(resolved.onTeardown).toBe(false)
  })

  it("global enabled:false disables both triggers absent a per-spawn override", () => {
    const resolved = resolveSandboxCheckpointConfig({ enabled: false }, undefined, {})
    expect(resolved.onTurnEnd).toBe(false)
    expect(resolved.onTeardown).toBe(false)
  })

  it("on omitting a trigger turns off only that one", () => {
    expect(resolveSandboxCheckpointConfig({ on: ["teardown"] }, undefined, {})).toMatchObject({
      onTurnEnd: false,
      onTeardown: true,
    })
    expect(resolveSandboxCheckpointConfig({ on: ["turn-end"] }, undefined, {})).toMatchObject({
      onTurnEnd: true,
      onTeardown: false,
    })
  })
})

describe("sandboxCheckpointOpts", () => {
  it("wires the checkpoint object only when onTurnEnd is true, carrying minIntervalMs/timeoutMs/refPrefix through", () => {
    const config = resolveSandboxCheckpointConfig(
      { on: ["turn-end"], minIntervalMs: 42, timeoutMs: 999, refPrefix: "custom/" },
      undefined,
      {},
    )
    const opts = sandboxCheckpointOpts({ exec: async () => result(1), target, outDir: "/tmp" }, config)
    expect(opts.checkpoint?.intervalMs).toBe(42)
  })

  it("returns no checkpoint object when onTurnEnd is false", () => {
    const config = resolveSandboxCheckpointConfig({ on: ["teardown"] }, undefined, {})
    const opts = sandboxCheckpointOpts({ exec: async () => result(1), target, outDir: "/tmp" }, config)
    expect(opts.checkpoint).toBeUndefined()
  })
})

describe("formatUncommittedRescueNotice", () => {
  const base: SandboxDeliveryRecord = {
    at: "t",
    branch: "wt/x",
    baseSha: target.baseSha,
    push: { status: "pushed" },
    bundle: { status: "skipped" },
  }

  it("names the ref and gives a fetch command when uncommitted work was rescued", () => {
    const notice = formatUncommittedRescueNotice({
      ...base,
      uncommittedFiles: 2,
      checkpoint: { status: "pushed", ref: "agentproto-checkpoint/wt/x", sha: SNAP },
    })
    expect(notice).toContain("2 uncommitted file(s)")
    expect(notice).toContain("agentproto-checkpoint/wt/x")
    expect(notice).toContain("git fetch origin agentproto-checkpoint/wt/x && git checkout FETCH_HEAD -- .")
  })

  it("is undefined when there is nothing uncommitted", () => {
    expect(formatUncommittedRescueNotice({ ...base, uncommittedFiles: 0 })).toBeUndefined()
    expect(formatUncommittedRescueNotice(base)).toBeUndefined()
  })

  it("is undefined when the rescue snapshot never reached the remote — nothing to fetch", () => {
    expect(
      formatUncommittedRescueNotice({
        ...base,
        uncommittedFiles: 2,
        checkpoint: { status: "failed", ref: "agentproto-checkpoint/wt/x", detail: "denied" },
      }),
    ).toBeUndefined()
  })
})

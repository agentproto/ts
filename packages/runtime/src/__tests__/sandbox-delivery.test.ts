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
  buildPushCommand,
  decideBundle,
  formatDeliveryNotice,
  parseProbe,
  runSandboxDelivery,
  shouldPush,
  withinBundleLimit,
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

  it("does nothing when no commits are ahead of base", async () => {
    const box = fakeBox({ ahead: 0 })
    const record = await runSandboxDelivery({ exec: box.exec, readFile: async () => new Uint8Array(), target, outDir })
    expect(record.push.status).toBe("skipped")
    expect(record.bundle.status).toBe("skipped")
    expect(box.commands).toHaveLength(1)
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

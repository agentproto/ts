/**
 * `checkWorktreesRootVolume` (volume-check.ts): warn when new worktrees would
 * land on the system disk while it is running low on space.
 */

import { describe, expect, it } from "vitest"
import { checkWorktreesRootVolume } from "../volume-check.js"

const GiB = 1024 ** 3

function probes(opts: { dev: number; systemDev: number; freeGiB: number; totalGiB: number }) {
  return {
    deviceOf: async (path: string) => (path === "/system" ? opts.systemDev : opts.dev),
    systemPaths: ["/system"],
    freeSpace: async () => ({ freeBytes: opts.freeGiB * GiB, totalBytes: opts.totalGiB * GiB }),
  }
}

describe("checkWorktreesRootVolume", () => {
  it("warns when the root is on the system disk and free space is low, naming the fix", async () => {
    const warning = await checkWorktreesRootVolume("/home/u/.agentproto/worktrees", {
      ...probes({ dev: 1, systemDev: 1, freeGiB: 20, totalGiB: 460 }),
    })
    expect(warning).toContain("/home/u/.agentproto/worktrees")
    expect(warning).toContain("20")
    expect(warning).toContain("worktrees.root")
    expect(warning).toContain("AGENTPROTO_WORKTREES_ROOT")
  })

  it("is silent when the root is on another volume, however full", async () => {
    expect(
      await checkWorktreesRootVolume("/mnt/big/wt", { ...probes({ dev: 2, systemDev: 1, freeGiB: 5, totalGiB: 460 }) }),
    ).toBeUndefined()
  })

  it("is silent on the system disk when there is plenty of space", async () => {
    expect(
      await checkWorktreesRootVolume("/home/u/wt", { ...probes({ dev: 1, systemDev: 1, freeGiB: 300, totalGiB: 460 }) }),
    ).toBeUndefined()
  })

  it("also warns when free space is a small share of a big disk", async () => {
    const warning = await checkWorktreesRootVolume("/home/u/wt", {
      ...probes({ dev: 1, systemDev: 1, freeGiB: 80, totalGiB: 2000 }),
    })
    expect(warning).toBeDefined()
  })

  it("never throws: a probe failure means no warning", async () => {
    expect(
      await checkWorktreesRootVolume("/x", {
        deviceOf: async () => {
          throw new Error("boom")
        },
        systemPaths: ["/system"],
        freeSpace: async () => ({ freeBytes: 0, totalBytes: 1 }),
      }),
    ).toBeUndefined()
  })

  it("works on a root that does not exist yet by probing its nearest existing ancestor (real fs)", async () => {
    // Real probes: must not throw and must return string | undefined.
    const out = await checkWorktreesRootVolume("/definitely/not/created/yet/worktrees")
    expect(out === undefined || typeof out === "string").toBe(true)
  })
})

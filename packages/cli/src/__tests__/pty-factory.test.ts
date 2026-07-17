/**
 * Unit tests for the node-pty spawn-helper self-heal + spawn-failure
 * diagnostics in ../util/pty-factory.ts.
 *
 * These exercise the pure helpers against a FIXTURE node-pty layout (a temp
 * dir with a fake `spawn-helper`) — no real node-pty, no real PTY spawn — so
 * they're deterministic and independent of how the running install's own
 * prebuilt binary happens to be permissioned.
 *
 * Root note: `chmod` under uid 0 is meaningless (root passes X_OK
 * unconditionally), so the repair/enrich cases that hinge on a NON-executable
 * file are skipped when the test runs as root (CI runners are not root).
 */

import { describe, expect, it } from "vitest"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  describeSpawnFailure,
  ensureSpawnHelperExecutable,
  spawnHelperCandidates,
} from "../util/pty-factory.js"

const isRoot = typeof process.getuid === "function" && process.getuid() === 0

function withFixture(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "nodepty-fixture-"))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Write a fake spawn-helper at `abs` with the given mode. */
function writeHelper(abs: string, mode: number): void {
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, "#!/bin/sh\nexit 0\n")
  chmodSync(abs, mode)
}

const hasExecBit = (p: string): boolean => (statSync(p).mode & 0o111) !== 0

describe("spawnHelperCandidates", () => {
  it("includes the platform+arch prebuild path and the build/Release path", () => {
    const cands = spawnHelperCandidates("/pkg/node-pty")
    expect(cands).toContain(
      join("/pkg/node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    )
    expect(cands).toContain(join("/pkg/node-pty", "build", "Release", "spawn-helper"))
  })
})

describe("ensureSpawnHelperExecutable", () => {
  it.skipIf(isRoot)("restores +x on a 0644 prebuilt spawn-helper", () => {
    withFixture(dir => {
      const helper = spawnHelperCandidates(dir)[0]!
      writeHelper(helper, 0o644)
      expect(hasExecBit(helper)).toBe(false)

      const repaired = ensureSpawnHelperExecutable(dir)

      expect(repaired).toEqual([helper])
      expect(hasExecBit(helper)).toBe(true)
    })
  })

  it("leaves an already-executable helper untouched (nothing repaired)", () => {
    withFixture(dir => {
      const helper = spawnHelperCandidates(dir)[0]!
      writeHelper(helper, 0o755)
      expect(ensureSpawnHelperExecutable(dir)).toEqual([])
      expect(hasExecBit(helper)).toBe(true)
    })
  })

  it("no-ops when no spawn-helper is present", () => {
    withFixture(dir => {
      expect(ensureSpawnHelperExecutable(dir)).toEqual([])
    })
  })

  it.skipIf(isRoot)("repairs the build/Release layout too", () => {
    withFixture(dir => {
      const helper = join(dir, "build", "Release", "spawn-helper")
      writeHelper(helper, 0o644)
      expect(ensureSpawnHelperExecutable(dir)).toEqual([helper])
      expect(hasExecBit(helper)).toBe(true)
    })
  })
})

describe("describeSpawnFailure", () => {
  it.skipIf(isRoot)("names the non-executable helper + chmod fix for a posix_spawnp failure", () => {
    withFixture(dir => {
      const helper = spawnHelperCandidates(dir)[0]!
      writeHelper(helper, 0o644)

      const msg = describeSpawnFailure(new Error("posix_spawnp failed."), {
        command: "/bin/cat",
        cwd: "/work",
        nodePtyDir: dir,
      })

      expect(msg).toContain("/bin/cat")
      expect(msg).toContain("cwd /work")
      expect(msg).toContain("posix_spawnp failed.")
      expect(msg).toContain(helper)
      expect(msg).toContain("chmod +x")
    })
  })

  it("attaches command + cwd but no helper hint for an unrelated error", () => {
    withFixture(dir => {
      // An executable helper present — so even a posix_spawn error adds no hint.
      writeHelper(spawnHelperCandidates(dir)[0]!, 0o755)
      const msg = describeSpawnFailure(new Error("ENOENT: no such file"), {
        command: "/nope/bin",
        cwd: "/work",
        nodePtyDir: dir,
      })
      expect(msg).toContain("/nope/bin")
      expect(msg).toContain("ENOENT")
      expect(msg).not.toContain("chmod +x")
    })
  })

  it("adds no helper hint once the helper has been repaired (self-heal composes)", () => {
    withFixture(dir => {
      const helper = spawnHelperCandidates(dir)[0]!
      writeHelper(helper, isRoot ? 0o755 : 0o644)
      ensureSpawnHelperExecutable(dir) // now executable
      const msg = describeSpawnFailure(new Error("posix_spawnp failed."), {
        command: "/bin/cat",
        nodePtyDir: dir,
      })
      expect(msg).not.toContain("chmod +x")
    })
  })

  it("degrades gracefully when node-pty dir is unknown", () => {
    const msg = describeSpawnFailure(new Error("posix_spawnp failed."), {
      command: "/bin/cat",
      nodePtyDir: null,
    })
    expect(msg).toContain("/bin/cat")
    expect(msg).toContain("posix_spawnp failed.")
    expect(msg).not.toContain("chmod +x")
  })
})

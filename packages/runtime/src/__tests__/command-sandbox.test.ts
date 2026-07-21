/**
 * OS-level confinement for `command_execute` (phase 2, macOS Seatbelt).
 * Unit-covers the pure profile/config/wrap logic on every platform, plus a
 * darwin-only end-to-end that actually runs `sandbox-exec` to PROVE a workspace
 * read is allowed while a home-dir read is denied.
 */

import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildSeatbeltProfile,
  loadSandboxConfig,
  resolveCommandSandbox,
  seatbeltSandbox,
} from "../command-sandbox.js"

describe("buildSeatbeltProfile", () => {
  it("allows default, denies home, re-allows workspace + extras, denies net (strict)", () => {
    const p = buildSeatbeltProfile({
      workspace: "/tmp/ws",
      extraReadPaths: ["/opt/data"],
      network: "deny",
    })
    expect(p).toContain("(allow default)")
    expect(p).toContain(`(deny file-read* file-write* (subpath "${homedir()}"))`)
    expect(p).toContain(`(allow file-read* file-write* (subpath "/tmp/ws"))`)
    expect(p).toContain(`(allow file-read* (subpath "/opt/data"))`)
    expect(p).toContain("(deny network*)")
  })

  it("omits the network deny when network=allow", () => {
    const p = buildSeatbeltProfile({
      workspace: "/tmp/ws",
      extraReadPaths: [],
      network: "allow",
    })
    expect(p).not.toContain("(deny network*)")
  })
})

describe("seatbeltSandbox.wrap", () => {
  const policy = { workspace: "/tmp/ws", extraReadPaths: [], network: "allow" as const }

  it("prepends sandbox-exec -p <profile> and preserves the original argv", () => {
    const argv = seatbeltSandbox.wrap(["node", "-e", "1"], policy)
    expect(argv[0]).toBe("sandbox-exec")
    expect(argv[1]).toBe("-p")
    expect(argv.slice(-3)).toEqual(["node", "-e", "1"])
  })

  it("leaves an empty argv unchanged", () => {
    expect(seatbeltSandbox.wrap([], policy)).toEqual([])
  })
})

describe("loadSandboxConfig", () => {
  async function withConfig(
    json: string | null,
    fn: (dir: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "sbxcfg-"))
    try {
      if (json !== null) {
        await mkdir(join(dir, ".agentproto"), { recursive: true })
        await writeFile(join(dir, ".agentproto", "command-sandbox.json"), json)
      }
      await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it("defaults to off when there is no config file", async () => {
    await withConfig(null, async dir => {
      expect((await loadSandboxConfig(dir)).mode).toBe("off")
    })
  })

  it("falls back to off on invalid JSON / unknown mode", async () => {
    await withConfig("{ not json", async dir => {
      expect((await loadSandboxConfig(dir)).mode).toBe("off")
    })
    await withConfig(JSON.stringify({ mode: "bananas" }), async dir => {
      expect((await loadSandboxConfig(dir)).mode).toBe("off")
    })
  })

  it("reads workspace mode + extraReadPaths; strict forces network deny", async () => {
    await withConfig(
      JSON.stringify({ mode: "workspace", extraReadPaths: ["/opt/x"] }),
      async dir => {
        const c = await loadSandboxConfig(dir)
        expect(c.mode).toBe("workspace")
        expect(c.extraReadPaths).toEqual(["/opt/x"])
        expect(c.network).toBe("allow")
      },
    )
    await withConfig(JSON.stringify({ mode: "strict" }), async dir => {
      const c = await loadSandboxConfig(dir)
      expect(c.mode).toBe("strict")
      expect(c.network).toBe("deny")
    })
  })
})

describe("resolveCommandSandbox", () => {
  it("returns the seatbelt backend on macOS, null elsewhere", () => {
    const backend = resolveCommandSandbox()
    if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
      expect(backend?.id).toBe("seatbelt")
    } else {
      expect(backend).toBeNull()
    }
  })
})

// End-to-end: only where Seatbelt actually exists. Skipped on Linux CI.
const canRunSeatbelt =
  process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")

describe.runIf(canRunSeatbelt)("seatbelt end-to-end", () => {
  it("allows a workspace read but denies a home-dir read", async () => {
    // Both dirs live under $HOME so the deny-home rule is what's under test:
    // the workspace re-allow must win for one and not the other.
    const base = await mkdtemp(join(homedir(), ".agentproto-sbxtest-"))
    try {
      const ws = join(base, "ws")
      const secretDir = join(base, "secret")
      await mkdir(ws)
      await mkdir(secretDir)
      await writeFile(join(ws, "inside.txt"), "workspace-ok")
      await writeFile(join(secretDir, "secret.txt"), "top-secret")

      const profile = buildSeatbeltProfile({
        workspace: ws,
        extraReadPaths: [],
        network: "allow",
      })

      // Allowed: reading inside the workspace.
      const out = execFileSync(
        "sandbox-exec",
        ["-p", profile, "/bin/cat", join(ws, "inside.txt")],
        { encoding: "utf8" },
      )
      expect(out).toContain("workspace-ok")

      // Denied: a sibling secret under $HOME (file exists, read is blocked).
      let denied = false
      try {
        execFileSync(
          "sandbox-exec",
          ["-p", profile, "/bin/cat", join(secretDir, "secret.txt")],
          { stdio: "pipe" },
        )
      } catch {
        denied = true
      }
      expect(denied).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

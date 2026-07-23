/**
 * OS-level confinement (macOS Seatbelt, Linux bubblewrap). Unit-covers the
 * pure profile/config/wrap logic on every platform, plus a darwin-only /
 * linux-only end-to-end that actually runs the backend to PROVE a workspace
 * read/write is allowed while a home-dir read is denied, and that an
 * `extraWritePaths` entry outside the workspace is writable too.
 */

import { describe, it, expect, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import {
  COMMAND_SANDBOX_MODE_ENV,
  buildBwrapArgs,
  buildSeatbeltProfile,
  bwrapSandbox,
  loadSandboxConfig,
  resolveCommandSandbox,
  seatbeltSandbox,
} from "../index.js"

describe("buildSeatbeltProfile", () => {
  it("allows default, denies home, re-allows workspace + extras, denies net (strict)", () => {
    const p = buildSeatbeltProfile({
      workspace: "/tmp/ws",
      extraReadPaths: ["/opt/data"],
      network: "deny",
    })
    expect(p).toContain("(allow default)")
    expect(p).toContain(`(deny file-read* file-write* (subpath "${homedir()}"))`)
    expect(p).toContain(`(allow file-read-metadata (subpath "${homedir()}"))`)
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

  it("re-allows extraWritePaths for read+write, distinct from read-only extraReadPaths", () => {
    const p = buildSeatbeltProfile({
      workspace: "/tmp/ws",
      extraReadPaths: ["/opt/data"],
      extraWritePaths: ["/opt/toolchain"],
      network: "allow",
    })
    expect(p).toContain(`(allow file-read* (subpath "/opt/data"))`)
    expect(p).toContain(`(allow file-read* file-write* (subpath "/opt/toolchain"))`)
  })

  it("omits any extraWritePaths clause when the field is undefined", () => {
    const p = buildSeatbeltProfile({
      workspace: "/tmp/ws",
      extraReadPaths: [],
      network: "allow",
    })
    expect(p).not.toContain("/opt/toolchain")
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

  describe(`${COMMAND_SANDBOX_MODE_ENV} override`, () => {
    const original = process.env[COMMAND_SANDBOX_MODE_ENV]
    afterEach(() => {
      if (original === undefined) delete process.env[COMMAND_SANDBOX_MODE_ENV]
      else process.env[COMMAND_SANDBOX_MODE_ENV] = original
    })

    it("overrides the file's mode when set to a valid mode", async () => {
      await withConfig(JSON.stringify({ mode: "off" }), async dir => {
        process.env[COMMAND_SANDBOX_MODE_ENV] = "workspace"
        expect((await loadSandboxConfig(dir)).mode).toBe("workspace")
      })
    })

    it("forces off even when the file asks for workspace/strict confinement", async () => {
      await withConfig(JSON.stringify({ mode: "strict" }), async dir => {
        process.env[COMMAND_SANDBOX_MODE_ENV] = "off"
        const c = await loadSandboxConfig(dir)
        expect(c.mode).toBe("off")
      })
    })

    it("is ignored when set to an invalid value", async () => {
      await withConfig(JSON.stringify({ mode: "workspace" }), async dir => {
        process.env[COMMAND_SANDBOX_MODE_ENV] = "bananas"
        expect((await loadSandboxConfig(dir)).mode).toBe("workspace")
      })
    })

    it("forcing 'strict' via env implies network deny even though the file didn't ask for it", async () => {
      await withConfig(JSON.stringify({ mode: "workspace" }), async dir => {
        process.env[COMMAND_SANDBOX_MODE_ENV] = "strict"
        const c = await loadSandboxConfig(dir)
        expect(c.mode).toBe("strict")
        expect(c.network).toBe("deny")
      })
    })
  })
})

function bwrapPath(): string | null {
  for (const p of ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]) {
    if (existsSync(p)) return p
  }
  return null
}

describe("resolveCommandSandbox", () => {
  it("picks seatbelt on macOS, bwrap on Linux (when installed), null otherwise", () => {
    const backend = resolveCommandSandbox()
    if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
      expect(backend?.id).toBe("seatbelt")
    } else if (process.platform === "linux" && bwrapPath()) {
      expect(backend?.id).toBe("bwrap")
    } else {
      expect(backend).toBeNull()
    }
  })
})

describe("buildBwrapArgs", () => {
  it("ro-binds system dirs, binds the workspace + extras, ends with -- argv", () => {
    const args = buildBwrapArgs(["node", "-e", "1"], {
      workspace: "/home/u/proj",
      extraReadPaths: ["/opt/cache"],
      network: "allow",
    })
    expect(args).toContain("--die-with-parent")
    // system dir bound read-only
    const usr = args.indexOf("--ro-bind-try")
    expect(args.slice(usr, usr + 3)).toEqual(["--ro-bind-try", "/usr", "/usr"])
    // workspace bound read-write
    const b = args.indexOf("--bind")
    expect(args.slice(b, b + 3)).toEqual([
      "--bind",
      "/home/u/proj",
      "/home/u/proj",
    ])
    expect(args).toContain("/opt/cache")
    // no network isolation when allowed
    expect(args).not.toContain("--unshare-net")
    // command runs after the `--` terminator
    const sep = args.indexOf("--")
    expect(args.slice(sep)).toEqual(["--", "node", "-e", "1"])
  })

  it("adds --unshare-net for strict (network=deny)", () => {
    const args = buildBwrapArgs(["node"], {
      workspace: "/home/u/proj",
      extraReadPaths: [],
      network: "deny",
    })
    expect(args).toContain("--unshare-net")
  })

  it("binds extraWritePaths read-write via --bind-try, distinct from --ro-bind-try reads", () => {
    const args = buildBwrapArgs(["node"], {
      workspace: "/home/u/proj",
      extraReadPaths: ["/opt/cache"],
      extraWritePaths: ["/opt/toolchain"],
      network: "allow",
    })
    const bt = args.indexOf("--bind-try")
    expect(args.slice(bt, bt + 3)).toEqual([
      "--bind-try",
      "/opt/toolchain",
      "/opt/toolchain",
    ])
    // the read path is still ro-bind-try, not promoted to writable
    const roIdx = args.indexOf("/opt/cache")
    expect(args[roIdx - 1]).toBe("--ro-bind-try")
  })
})

describe("bwrapSandbox.wrap", () => {
  const policy = { workspace: "/home/u/proj", extraReadPaths: [], network: "allow" as const }

  it("prepends bwrap and ends with the original argv", () => {
    const argv = bwrapSandbox.wrap(["node", "-e", "1"], policy)
    expect(argv[0]).toBe("bwrap")
    expect(argv.slice(-3)).toEqual(["node", "-e", "1"])
  })

  it("leaves an empty argv unchanged", () => {
    expect(bwrapSandbox.wrap([], policy)).toEqual([])
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

  it("allows a write into an extraWritePaths dir outside the workspace", async () => {
    const base = await mkdtemp(join(homedir(), ".agentproto-sbxtest-"))
    try {
      const ws = join(base, "ws")
      const toolchain = join(base, "toolchain")
      await mkdir(ws)
      await mkdir(toolchain)

      const profile = buildSeatbeltProfile({
        workspace: ws,
        extraReadPaths: [],
        extraWritePaths: [toolchain],
        network: "allow",
      })

      execFileSync("sandbox-exec", [
        "-p",
        profile,
        "/usr/bin/touch",
        join(toolchain, "written-by-sandbox"),
      ])
      expect(existsSync(join(toolchain, "written-by-sandbox"))).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it("allows stat on $HOME itself (npm/npx's ancestor-directory lstat walk) while still denying directory listing and file content under an unrelated sibling", async () => {
    // Empirically discovered running a real `npx <adapter>` under a
    // `workspace`-mode profile (2026-07-22): npm's arborist `lstat`s $HOME
    // itself while resolving config, and hard-fails with EPERM without
    // this metadata-only re-allow — even though it never touches any
    // OTHER path under $HOME. `stat` exercises the same lstat-class
    // syscall from the shell.
    const ws = await mkdtemp(join(tmpdir(), "sbx-home-stat-ws-"))
    try {
      const profile = buildSeatbeltProfile({
        workspace: ws,
        extraReadPaths: [],
        network: "allow",
      })

      // Allowed: metadata-only stat on $HOME itself.
      const out = execFileSync(
        "sandbox-exec",
        ["-p", profile, "/usr/bin/stat", "-f", "%N", homedir()],
        { encoding: "utf8" },
      )
      expect(out.trim()).toBe(homedir())

      // Still denied: listing $HOME's contents (needs file-read-data, not
      // just metadata).
      let listingDenied = false
      try {
        execFileSync("sandbox-exec", ["-p", profile, "/bin/ls", homedir()], {
          stdio: "pipe",
        })
      } catch {
        listingDenied = true
      }
      expect(listingDenied).toBe(true)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})

// End-to-end: only where bubblewrap actually exists. Skipped on macOS.
const canRunBwrap = process.platform === "linux" && bwrapPath() !== null

describe.runIf(canRunBwrap)("bwrap end-to-end", () => {
  it("allows a bound workspace read but denies an unbound sibling", async () => {
    const base = await mkdtemp(join(tmpdir(), "bwraptest-"))
    try {
      const ws = join(base, "ws")
      const secretDir = join(base, "secret")
      await mkdir(ws)
      await mkdir(secretDir)
      await writeFile(join(ws, "inside.txt"), "workspace-ok")
      await writeFile(join(secretDir, "secret.txt"), "top-secret")

      const policy = { workspace: ws, extraReadPaths: [], network: "allow" as const }

      // Allowed: the workspace is bound.
      const out = execFileSync(
        "bwrap",
        buildBwrapArgs(["cat", join(ws, "inside.txt")], policy),
        { encoding: "utf8" },
      )
      expect(out).toContain("workspace-ok")

      // Denied: the sibling dir is not bound, so the path is invisible inside.
      let denied = false
      try {
        execFileSync(
          "bwrap",
          buildBwrapArgs(["cat", join(secretDir, "secret.txt")], policy),
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

  it("allows a write into an extraWritePaths dir outside the workspace", async () => {
    const base = await mkdtemp(join(tmpdir(), "bwraptest-"))
    try {
      const ws = join(base, "ws")
      const toolchain = join(base, "toolchain")
      await mkdir(ws)
      await mkdir(toolchain)

      const policy = {
        workspace: ws,
        extraReadPaths: [],
        extraWritePaths: [toolchain],
        network: "allow" as const,
      }

      execFileSync(
        "bwrap",
        buildBwrapArgs(["touch", join(toolchain, "written-by-sandbox")], policy),
      )
      expect(existsSync(join(toolchain, "written-by-sandbox"))).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

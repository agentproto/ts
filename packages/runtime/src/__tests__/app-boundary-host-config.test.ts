/**
 * App boundary: harness project config in the hidden host repo.
 *
 * An app installed inside a git repo (a monorepo holding `apps/my-app/`) gets
 * that repo as a `hidden` zone. Harnesses walk up to the git root to load
 * their project config (Claude Code: `.claude/settings.json`,
 * `.claude/settings.local.json`, hooks, `CLAUDE.md`), so the whole-repo deny
 * made every step start with "Settings file could not be read: EPERM" and
 * without the project's hooks and permission rules. These files stay
 * readable, never writable; the rest of the repo stays hidden and secrets
 * inside `.claude/` stay masked.
 */

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { userInfo } from "node:os"
import { join } from "node:path"
import { buildBwrapArgs, resolveCommandSandbox } from "@agentproto/command-sandbox"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  boundaryFromMeta,
  boundaryMeta,
  boundaryToSandboxZones,
  buildAppBoundary,
  FsZoneError,
  resolveBoundaryPath,
  type AppBoundary,
} from "../app-boundary.js"

let base: string
let repo: string
let appDir: string
let runWorkspace: string

beforeEach(() => {
  // Under the real home: the vitest setup fakes $HOME into the OS temp dir,
  // which the sandbox treats as writable scratch.
  base = realpathSync(mkdtempSync(join(userInfo().homedir, ".agentproto-hostcfg-")))
  repo = join(base, "repo")
  appDir = join(repo, "apps", "my-app")
  runWorkspace = join(base, "runs", "wfrun_1")
  mkdirSync(join(repo, ".claude", "hooks"), { recursive: true })
  mkdirSync(join(repo, "src"), { recursive: true })
  mkdirSync(appDir, { recursive: true })
  execFileSync("git", ["init", "-q", repo])
  writeFileSync(join(repo, ".claude", "settings.json"), '{"hooks":{}}')
  writeFileSync(join(repo, ".claude", "settings.local.json"), '{"permissions":{"allow":["Bash(ls)"]}}')
  writeFileSync(join(repo, ".claude", "hooks", "pre.sh"), "#!/bin/sh\nexit 0\n")
  writeFileSync(join(repo, ".claude", ".env"), "API_KEY=secret")
  writeFileSync(join(repo, "CLAUDE.md"), "host instructions")
  writeFileSync(join(repo, "AGENTS.md"), "host agents")
  writeFileSync(join(repo, "src", "private.ts"), "export const x = 1")
  writeFileSync(join(repo, ".env"), "ROOT_SECRET=1")
  writeFileSync(join(appDir, "APP.md"), "app")
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function boundary(): AppBoundary {
  return buildAppBoundary({ app: { appId: "@test/my-app", dir: appDir }, runWorkspace })
}

describe("buildAppBoundary: host repo harness config", () => {
  it("hides the host repo but re-opens its harness config read-only", () => {
    const b = boundary()
    expect(b.hidden).toEqual([repo])
    const cfg = [join(repo, ".claude"), join(repo, "CLAUDE.md"), join(repo, "AGENTS.md")]
    expect(b.hostConfig).toEqual(cfg)
    expect(b.readOnly).toEqual([appDir, ...cfg])
    expect(b.writable).toEqual([runWorkspace])
    expect(b.unreadable).toEqual([join(repo, ".claude", ".env")])
    expect(boundaryFromMeta(boundaryMeta(b))).toEqual(b)
  })

  it("daemon file tools: config readable, never writable; the rest of the repo and secrets stay denied", () => {
    const b = boundary()
    const settings = join(repo, ".claude", "settings.local.json")
    expect(resolveBoundaryPath(b, settings, "read")).toBe(settings)
    expect(resolveBoundaryPath(b, join(repo, "CLAUDE.md"), "read")).toBe(join(repo, "CLAUDE.md"))
    expect(() => resolveBoundaryPath(b, settings, "write")).toThrow(FsZoneError)
    expect(() => resolveBoundaryPath(b, join(repo, ".claude", "new.json"), "write")).toThrow(FsZoneError)
    expect(() => resolveBoundaryPath(b, join(repo, "src", "private.ts"), "read")).toThrow(FsZoneError)
    expect(() => resolveBoundaryPath(b, join(repo, ".env"), "read")).toThrow(FsZoneError)
    expect(() => resolveBoundaryPath(b, join(repo, ".claude", ".env"), "read")).toThrow(/protected secret/)
  })

  it("covers .codex/ and skips an entry whose real path leaves the repo", () => {
    mkdirSync(join(repo, ".codex"))
    writeFileSync(join(repo, ".codex", "config.toml"), "")
    const outside = join(base, "elsewhere")
    mkdirSync(outside)
    writeFileSync(join(outside, "AGENTS.md"), "not the repo's")
    rmSync(join(repo, "AGENTS.md"))
    symlinkSync(join(outside, "AGENTS.md"), join(repo, "AGENTS.md"))
    const b = boundary()
    expect(b.hostConfig).toEqual([join(repo, ".claude"), join(repo, ".codex"), join(repo, "CLAUDE.md")])
    expect(() => resolveBoundaryPath(b, join(outside, "AGENTS.md"), "read")).toThrow(FsZoneError)
  })

  it("adds nothing when the app is not inside a git repo", () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true })
    const b = boundary()
    expect(b.hidden).toEqual([])
    expect(b.hostConfig).toBeUndefined()
    expect(b.readOnly).toEqual([appDir])
  })

  it("bubblewrap binds only the config read-only, never the repo itself", () => {
    const args = buildBwrapArgs(["/bin/true"], {
      workspace: appDir,
      extraReadPaths: [],
      zones: boundaryToSandboxZones(boundary()),
      network: "allow",
    })
    const roBinds = args.flatMap((a, i) => (a === "--ro-bind-try" ? [args[i + 1]] : []))
    expect(roBinds).toEqual(expect.arrayContaining([join(repo, ".claude"), join(repo, "CLAUDE.md"), join(repo, "AGENTS.md")]))
    const anyBinds = args.flatMap((a, i) => (a.includes("bind") ? [args[i + 1]] : []))
    expect(anyBinds).not.toContain(repo)
    expect(anyBinds).not.toContain(join(repo, "src"))
    // Read-write binds never touch the host repo.
    const rwBinds = args.flatMap((a, i) => (a === "--bind-try" || a === "--bind" ? [args[i + 1]] : []))
    expect(rwBinds.filter(p => p!.startsWith(repo + "/") && !p!.startsWith(appDir))).toEqual([])
    // The secret inside `.claude/` is masked.
    const envIdx = args.indexOf(join(repo, ".claude", ".env"))
    expect(args.slice(envIdx - 2, envIdx + 1)).toEqual(["--ro-bind", "/dev/null", join(repo, ".claude", ".env")])
  })
})

function sandboxRunnable(): boolean {
  if (process.platform !== "darwin") return false
  const sb = resolveCommandSandbox()
  if (!sb) return false
  try {
    const argv = sb.wrap(["/usr/bin/true"], { workspace: userInfo().homedir, extraReadPaths: [], network: "allow" })
    execFileSync(argv[0]!, argv.slice(1), { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!sandboxRunnable())("seatbelt end-to-end: host repo harness config", () => {
  const run = (zones: ReturnType<typeof boundaryToSandboxZones>, ...argv: string[]): boolean => {
    const wrapped = resolveCommandSandbox()!.wrap(argv, { workspace: appDir, extraReadPaths: [], zones, network: "allow" })
    try {
      execFileSync(wrapped[0]!, wrapped.slice(1), { stdio: "pipe" })
      return true
    } catch {
      return false
    }
  }

  it("a step can read the host .claude settings, CLAUDE.md and AGENTS.md", () => {
    const zones = boundaryToSandboxZones(boundary())
    expect(run(zones, "/bin/cat", join(repo, ".claude", "settings.local.json"))).toBe(true)
    expect(run(zones, "/bin/cat", join(repo, ".claude", "settings.json"))).toBe(true)
    expect(run(zones, "/bin/cat", join(repo, ".claude", "hooks", "pre.sh"))).toBe(true)
    expect(run(zones, "/bin/cat", join(repo, "CLAUDE.md"))).toBe(true)
    expect(run(zones, "/bin/cat", join(repo, "AGENTS.md"))).toBe(true)
    expect(run(zones, "/bin/cat", join(appDir, "APP.md"))).toBe(true)
  })

  it("the rest of the host repo stays unreadable, secrets stay masked, and nothing in it is writable", () => {
    const zones = boundaryToSandboxZones(boundary())
    const settings = join(repo, ".claude", "settings.local.json")
    expect(run(zones, "/bin/cat", join(repo, "src", "private.ts"))).toBe(false)
    expect(run(zones, "/bin/ls", join(repo, "src"))).toBe(false)
    expect(run(zones, "/bin/cat", join(repo, ".env"))).toBe(false)
    expect(run(zones, "/bin/cat", join(repo, ".claude", ".env"))).toBe(false)
    expect(run(zones, "/bin/sh", "-c", `echo pwned > '${settings}'`)).toBe(false)
    expect(run(zones, "/usr/bin/touch", join(repo, ".claude", "new.json"))).toBe(false)
    expect(run(zones, "/bin/rm", join(repo, "CLAUDE.md"))).toBe(false)
    expect(run(zones, "/usr/bin/touch", join(repo, "x"))).toBe(false)
    expect(readFileSync(settings, "utf8")).toBe('{"permissions":{"allow":["Bash(ls)"]}}')
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("host instructions")
  })
})

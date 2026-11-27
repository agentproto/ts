/**
 * App boundary: the hidden host repo an app is installed inside.
 *
 * An app installed inside a git repo (a monorepo holding `apps/my-app/`) gets
 * that repo as a `hidden` zone. Tools walk up to the repo root from the app
 * dir: git and rg to `.git` / `.gitignore`, Claude Code to
 * `.claude/settings.json`, `.claude/settings.local.json`, hooks and
 * `CLAUDE.md`. The whole-repo deny made every step start with "Settings file
 * could not be read: EPERM", `rg` fail on `.git`, and a step calling a
 * sibling package's built CLI fail to read it. Now:
 *   - the repo's root config is readable for every app, never writable;
 *   - an app reads the sibling paths it declares in `boundaries.hostReads`,
 *     never writable, only inside its own host repo;
 *   - the rest of the repo stays hidden and secrets stay masked.
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { userInfo } from "node:os"
import { dirname, join } from "node:path"
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
let siblingCli: string
let shared: string

const write = (p: string, content: string): void => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", repo, "-c", "user.email=t@e.com", "-c", "user.name=T", ...args], { encoding: "utf8" })

beforeEach(() => {
  // Under the real home: the vitest setup fakes $HOME into the OS temp dir,
  // which the sandbox treats as writable scratch.
  base = realpathSync(mkdtempSync(join(userInfo().homedir, ".agentproto-hostcfg-")))
  repo = join(base, "repo")
  appDir = join(repo, "apps", "my-app")
  runWorkspace = join(base, "runs", "wfrun_1")
  siblingCli = join(repo, "packages", "other-tool", "packages", "cli", "dist")
  shared = join(repo, "apps", "_shared")
  mkdirSync(repo, { recursive: true })
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  write(join(repo, ".gitignore"), ".env\n.env.*\n")
  write(join(repo, ".claude", "settings.json"), '{"hooks":{}}')
  write(join(repo, ".claude", "settings.local.json"), '{"permissions":{"allow":["Bash(ls)"]}}')
  write(join(repo, ".claude", "hooks", "pre.sh"), "#!/bin/sh\nexit 0\n")
  write(join(repo, ".claude", ".env"), "API_KEY=secret")
  write(join(repo, ".mcp.json"), '{"mcpServers":{}}')
  write(join(repo, "CLAUDE.md"), "host instructions")
  write(join(repo, "AGENTS.md"), "host agents")
  write(join(repo, "src", "private.ts"), "export const x = 1")
  write(join(repo, ".env"), "ROOT_SECRET=1")
  write(join(siblingCli, "index.js"), "console.log('sibling cli')")
  write(join(repo, "packages", "other-tool", "src", "internal.ts"), "internal")
  write(join(shared, "lib.mjs"), "export const shared = 1")
  write(join(shared, ".env.local"), "SHARED_SECRET=1")
  write(join(appDir, "APP.md"), "app needle")
  git("add", "-A")
  git("commit", "-q", "-m", "init")
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function boundary(hostReads?: string[], warn?: (line: string) => void): AppBoundary {
  return buildAppBoundary({
    app: { appId: "@test/my-app", dir: appDir, ...(hostReads ? { boundaries: { hostReads } } : {}) },
    runWorkspace,
    ...(warn ? { warn } : {}),
  })
}

const ROOT_CONFIG = (): string[] => [
  join(repo, ".git"),
  join(repo, ".gitignore"),
  join(repo, ".claude"),
  join(repo, ".mcp.json"),
  join(repo, "CLAUDE.md"),
  join(repo, "AGENTS.md"),
]

describe("buildAppBoundary: host repo config (every app)", () => {
  it("hides the host repo but re-opens its root config read-only", () => {
    const b = boundary()
    expect(b.hidden).toEqual([repo])
    expect(b.hostConfig).toEqual(ROOT_CONFIG())
    expect(b.readOnly).toEqual([appDir, ...ROOT_CONFIG()])
    expect(b.writable).toEqual([runWorkspace])
    expect(b.unreadable).toEqual([join(repo, ".claude", ".env")])
    expect(b.hostReads).toBeUndefined()
    expect(boundaryFromMeta(boundaryMeta(b))).toEqual(b)
  })

  it("daemon file tools: config readable, never writable; the rest of the repo and secrets stay denied", () => {
    const b = boundary()
    const settings = join(repo, ".claude", "settings.local.json")
    expect(resolveBoundaryPath(b, settings, "read")).toBe(settings)
    expect(resolveBoundaryPath(b, join(repo, ".git", "HEAD"), "read")).toBe(join(repo, ".git", "HEAD"))
    expect(resolveBoundaryPath(b, join(repo, "CLAUDE.md"), "read")).toBe(join(repo, "CLAUDE.md"))
    expect(() => resolveBoundaryPath(b, settings, "write")).toThrow(FsZoneError)
    expect(() => resolveBoundaryPath(b, join(repo, ".git", "HEAD"), "write")).toThrow(FsZoneError)
    expect(() => resolveBoundaryPath(b, join(repo, ".claude", "new.json"), "write")).toThrow(FsZoneError)
    expect(() => resolveBoundaryPath(b, join(repo, "src", "private.ts"), "read")).toThrow(FsZoneError)
    expect(() => resolveBoundaryPath(b, join(siblingCli, "index.js"), "read")).toThrow(FsZoneError)
    expect(() => resolveBoundaryPath(b, join(repo, ".env"), "read")).toThrow(FsZoneError)
    expect(() => resolveBoundaryPath(b, join(repo, ".claude", ".env"), "read")).toThrow(/protected secret/)
  })

  it("covers .codex/ and skips an entry whose real path leaves the repo", () => {
    write(join(repo, ".codex", "config.toml"), "")
    const outside = join(base, "elsewhere")
    write(join(outside, "AGENTS.md"), "not the repo's")
    rmSync(join(repo, "AGENTS.md"))
    symlinkSync(join(outside, "AGENTS.md"), join(repo, "AGENTS.md"))
    const b = boundary()
    expect(b.hostConfig).toEqual([
      join(repo, ".git"),
      join(repo, ".gitignore"),
      join(repo, ".claude"),
      join(repo, ".codex"),
      join(repo, ".mcp.json"),
      join(repo, "CLAUDE.md"),
    ])
    expect(() => resolveBoundaryPath(b, join(outside, "AGENTS.md"), "read")).toThrow(FsZoneError)
  })

  it("a linked worktree's .git file also opens the git dirs it points at, read-only", () => {
    const wt = join(base, "wt")
    git("worktree", "add", "-q", wt)
    const wtApp = join(wt, "apps", "my-app")
    const b = buildAppBoundary({ app: { appId: "@test/my-app", dir: wtApp } })
    const commonDir = join(repo, ".git")
    expect(b.hidden).toEqual([wt])
    expect(b.hostConfig).toEqual(expect.arrayContaining([join(wt, ".git"), join(commonDir, "worktrees", "wt"), commonDir]))
    expect(() => resolveBoundaryPath(b, join(commonDir, "HEAD"), "write")).toThrow(FsZoneError)
  })

  it("masks .git/config only when it carries credentials, and says so", () => {
    expect(boundary().unreadable).toEqual([join(repo, ".claude", ".env")])
    git("remote", "add", "origin", "git@example.com:org/repo.git")
    git("remote", "add", "ssh", "ssh://git@example.com/org/repo.git")
    expect(boundary().unreadable).toEqual([join(repo, ".claude", ".env")])
    for (const [key, value] of [
      ["remote.tok.url", "https://x-access-token:abc123@example.com/org/repo.git"],
      ["http.https://example.com/.extraheader", "AUTHORIZATION: bearer abc123"],
    ] as const) {
      const fresh = realpathSync(mkdtempSync(join(userInfo().homedir, ".agentproto-hostcfg-cred-")))
      try {
        execFileSync("git", ["init", "-q", fresh])
        execFileSync("git", ["-C", fresh, "config", key, value])
        mkdirSync(join(fresh, "apps", "my-app"), { recursive: true })
        const warnings: string[] = []
        const b = buildAppBoundary({ app: { appId: "@test/my-app", dir: join(fresh, "apps", "my-app") }, warn: l => warnings.push(l) })
        expect(b.unreadable).toContain(join(fresh, ".git", "config"))
        expect(() => resolveBoundaryPath(b, join(fresh, ".git", "config"), "read")).toThrow(/protected secret/)
        expect(resolveBoundaryPath(b, join(fresh, ".git", "HEAD"), "read")).toBe(join(fresh, ".git", "HEAD"))
        expect(warnings.join("\n")).toMatch(/holds credentials/)
      } finally {
        rmSync(fresh, { recursive: true, force: true })
      }
    }
  })

  it("adds nothing when the app is not inside a git repo", () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true })
    const b = boundary(["packages/other-tool/packages/cli/dist"])
    expect(b.hidden).toEqual([])
    expect(b.hostConfig).toBeUndefined()
    expect(b.hostReads).toBeUndefined()
    expect(b.readOnly).toEqual([appDir])
  })
})

describe("buildAppBoundary: boundaries.hostReads", () => {
  it("opens the declared sibling paths read-only and masks secrets inside them", () => {
    const b = boundary(["packages/other-tool/packages/cli/dist", "apps/_shared"])
    expect(b.hostReads).toEqual([siblingCli, shared])
    expect(b.readOnly).toEqual([appDir, ...ROOT_CONFIG(), siblingCli, shared])
    expect(b.unreadable).toEqual(expect.arrayContaining([join(shared, ".env.local")]))
    expect(resolveBoundaryPath(b, join(siblingCli, "index.js"), "read")).toBe(join(siblingCli, "index.js"))
    expect(resolveBoundaryPath(b, join(shared, "lib.mjs"), "read")).toBe(join(shared, "lib.mjs"))
    expect(() => resolveBoundaryPath(b, join(siblingCli, "index.js"), "write")).toThrow(FsZoneError)
    expect(() => resolveBoundaryPath(b, join(shared, ".env.local"), "read")).toThrow(/protected secret/)
    expect(() => resolveBoundaryPath(b, join(repo, "packages", "other-tool", "src", "internal.ts"), "read")).toThrow(FsZoneError)
    expect(boundaryFromMeta(boundaryMeta(b))).toEqual(b)
  })

  it("refuses entries that leave the host repo, name the whole repo, a secret, or do not exist", () => {
    const outside = join(base, "elsewhere")
    write(join(outside, "x.txt"), "outside")
    symlinkSync(outside, join(repo, "escape"))
    const warnings: string[] = []
    const b = boundary(["../elsewhere", "escape", ".", "", "/etc", ".env", "missing/dir", "apps/_shared"], l => warnings.push(l))
    expect(b.hostReads).toEqual([shared])
    expect(warnings).toHaveLength(7)
    expect(warnings.join("\n")).toMatch(/'escape' refused: resolves outside the host repo/)
    expect(warnings.join("\n")).toMatch(/'\.' refused: refusing the whole host repo/)
    expect(warnings.join("\n")).toMatch(/'\.env' refused: refusing a secrets file/)
    expect(() => resolveBoundaryPath(b, join(outside, "x.txt"), "read")).toThrow(FsZoneError)
  })
})

describe("bubblewrap argv (Linux)", () => {
  it("binds the root config and declared reads read-only, never the repo itself", () => {
    const args = buildBwrapArgs(["/bin/true"], {
      workspace: appDir,
      extraReadPaths: [],
      zones: boundaryToSandboxZones(boundary(["packages/other-tool/packages/cli/dist"])),
      network: "allow",
    })
    const roBinds = args.flatMap((a, i) => (a === "--ro-bind-try" ? [args[i + 1]] : []))
    expect(roBinds).toEqual(expect.arrayContaining([...ROOT_CONFIG(), siblingCli]))
    const anyBinds = args.flatMap((a, i) => (a.includes("bind") ? [args[i + 1]] : []))
    expect(anyBinds).not.toContain(repo)
    expect(anyBinds).not.toContain(join(repo, "src"))
    const rwBinds = args.flatMap((a, i) => (a === "--bind-try" || a === "--bind" ? [args[i + 1]] : []))
    expect(rwBinds.filter(p => p!.startsWith(repo + "/"))).toEqual([])
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

const RG = ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"].find(p => existsSync(p))

describe.skipIf(!sandboxRunnable())("seatbelt end-to-end: host repo", () => {
  const exec = (zones: ReturnType<typeof boundaryToSandboxZones>, ...argv: string[]): { ok: boolean; out: string } => {
    const wrapped = resolveCommandSandbox()!.wrap(argv, { workspace: appDir, extraReadPaths: [], zones, network: "allow" })
    try {
      const out = execFileSync(wrapped[0]!, wrapped.slice(1), { cwd: appDir, encoding: "utf8", stdio: "pipe" })
      return { ok: true, out }
    } catch (err) {
      return { ok: false, out: String((err as { stderr?: unknown }).stderr ?? "") }
    }
  }
  const run = (zones: ReturnType<typeof boundaryToSandboxZones>, ...argv: string[]): boolean => exec(zones, ...argv).ok

  it("a step can read what the harness and git read at the host repo root", () => {
    const zones = boundaryToSandboxZones(boundary())
    expect(run(zones, "/bin/cat", join(repo, ".claude", "settings.local.json"))).toBe(true)
    expect(run(zones, "/bin/cat", join(repo, ".claude", "settings.json"))).toBe(true)
    expect(run(zones, "/bin/cat", join(repo, ".claude", "hooks", "pre.sh"))).toBe(true)
    expect(run(zones, "/bin/cat", join(repo, "CLAUDE.md"))).toBe(true)
    expect(run(zones, "/bin/cat", join(repo, "AGENTS.md"))).toBe(true)
    expect(run(zones, "/bin/cat", join(repo, ".git", "HEAD"))).toBe(true)
    expect(run(zones, "/bin/cat", join(repo, ".mcp.json"))).toBe(true)
    expect(run(zones, "/bin/ls", join(repo, ".claude", "hooks"))).toBe(true)
    expect(run(zones, "/bin/cat", join(appDir, "APP.md"))).toBe(true)
  })

  it("git log / ls-files / status work from the app dir; git writes stay denied", () => {
    const zones = boundaryToSandboxZones(boundary())
    expect(exec(zones, "/usr/bin/git", "log", "--oneline", "-1").out).toMatch(/init/)
    expect(exec(zones, "/usr/bin/git", "ls-files", ".").out.trim()).toBe("APP.md")
    expect(exec(zones, "/usr/bin/git", "status", "--porcelain", "--", ".").ok).toBe(true)
    expect(run(zones, "/usr/bin/git", "branch", "step-was-here")).toBe(false)
    expect(git("branch", "--list", "step-was-here")).toBe("")
  })

  it.skipIf(!RG)("rg runs from the app dir without tripping on the hidden repo's .git", () => {
    const zones = boundaryToSandboxZones(boundary())
    const r = exec(zones, RG!, "needle", ".")
    expect(r.out).not.toMatch(/Operation not permitted/)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/APP\.md/)
  })

  it.skipIf(!RG)("in a linked worktree (`.git` is a file), rg and git work from the app dir; git writes stay denied", () => {
    const wt = join(base, "wt")
    git("worktree", "add", "-q", wt)
    const wtApp = join(wt, "apps", "my-app")
    const zones = boundaryToSandboxZones(buildAppBoundary({ app: { appId: "@test/my-app", dir: wtApp } }))
    const execIn = (...argv: string[]): { ok: boolean; out: string } => {
      const wrapped = resolveCommandSandbox()!.wrap(argv, { workspace: wtApp, extraReadPaths: [], zones, network: "allow" })
      try {
        return { ok: true, out: execFileSync(wrapped[0]!, wrapped.slice(1), { cwd: wtApp, encoding: "utf8", stdio: "pipe" }) }
      } catch (err) {
        return { ok: false, out: String((err as { stderr?: unknown }).stderr ?? "") }
      }
    }
    // An explicit path: with no path and a piped stdin, rg searches stdin.
    const rg = execIn(RG!, "needle", ".")
    expect(rg.out).not.toMatch(/Operation not permitted/)
    expect(rg.ok).toBe(true)
    expect(execIn("/usr/bin/git", "log", "--oneline", "-1").out).toMatch(/init/)
    expect(execIn("/usr/bin/git", "ls-files", ".").out.trim()).toBe("APP.md")
    expect(execIn("/usr/bin/git", "branch", "step-was-here").ok).toBe(false)
    expect(git("branch", "--list", "step-was-here")).toBe("")
  })

  it("a declared sibling CLI and shared folder are readable, not writable", () => {
    const zones = boundaryToSandboxZones(boundary(["packages/other-tool/packages/cli/dist", "apps/_shared"]))
    expect(run(zones, "/bin/cat", join(siblingCli, "index.js"))).toBe(true)
    expect(run(zones, "/bin/cat", join(shared, "lib.mjs"))).toBe(true)
    expect(run(zones, "/bin/cat", join(shared, ".env.local"))).toBe(false)
    expect(run(zones, "/usr/bin/touch", join(siblingCli, "x.js"))).toBe(false)
    expect(run(zones, "/bin/cat", join(repo, "packages", "other-tool", "src", "internal.ts"))).toBe(false)
  })

  it("the rest of the host repo stays unreadable, secrets stay masked, and nothing in it is writable", () => {
    const zones = boundaryToSandboxZones(boundary())
    const settings = join(repo, ".claude", "settings.local.json")
    expect(run(zones, "/bin/cat", join(repo, "src", "private.ts"))).toBe(false)
    expect(run(zones, "/bin/ls", join(repo, "src"))).toBe(false)
    expect(run(zones, "/bin/cat", join(siblingCli, "index.js"))).toBe(false)
    expect(run(zones, "/bin/cat", join(repo, ".env"))).toBe(false)
    expect(run(zones, "/bin/cat", join(repo, ".claude", ".env"))).toBe(false)
    expect(run(zones, "/bin/sh", "-c", `echo pwned > '${settings}'`)).toBe(false)
    expect(run(zones, "/usr/bin/touch", join(repo, ".claude", "new.json"))).toBe(false)
    expect(run(zones, "/usr/bin/touch", join(repo, ".git", "x"))).toBe(false)
    expect(run(zones, "/bin/rm", join(repo, "CLAUDE.md"))).toBe(false)
    expect(run(zones, "/usr/bin/touch", join(repo, "x"))).toBe(false)
    expect(readFileSync(settings, "utf8")).toBe('{"permissions":{"allow":["Bash(ls)"]}}')
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("host instructions")
  })
})

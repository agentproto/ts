/**
 * Operator read grants for apps (`apps.readGrants`): validation, boundary
 * zones, the "an app cannot grant itself" invariant, and a real Seatbelt
 * check that the grant is readable, unwritable, and masks secrets inside it.
 */

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { resolveCommandSandbox } from "@agentproto/command-sandbox"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  boundaryFromMeta,
  boundaryMeta,
  boundaryToSandboxZones,
  buildAppBoundary,
  describeBoundary,
  FsZoneError,
  resolveBoundaryPath,
} from "../app-boundary.js"
import {
  createAppReadGrantResolver,
  findSecretsInTree,
  isSecretFileName,
  validateAppReadGrants,
} from "../app-read-grants.js"
import { agentprotoConfigSchema, findConfigKey, validateConfigKeyType, validateConfigKeyValue } from "../config-schema.js"

let base: string
let home: string
let appDir: string
let facts: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "app-grants-")))
  home = join(base, "home")
  appDir = join(home, "apps", "editorial-desk")
  facts = join(home, "code", "simone")
  mkdirSync(appDir, { recursive: true })
  mkdirSync(join(facts, "docs"), { recursive: true })
  writeFileSync(join(facts, "docs", "facts.md"), "simone facts")
  writeFileSync(join(facts, ".env"), "SECRET=1")
  writeFileSync(join(facts, ".env.example"), "SECRET=")
  mkdirSync(join(home, ".ssh"), { recursive: true })
  mkdirSync(join(home, ".config", "x"), { recursive: true })
  mkdirSync(join(home, ".aws"), { recursive: true })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

const grantsFor = (raw: unknown, extra: { daemonWorkspace?: string } = {}) =>
  validateAppReadGrants(raw, { home, ...extra })

describe("validateAppReadGrants", () => {
  it("accepts an existing absolute directory and returns its canonical path", () => {
    const link = join(base, "link-to-facts")
    symlinkSync(facts, link)
    const r = grantsFor({ "editorial-desk": [facts, link, `~/code/simone`] })
    expect(r.rejected).toEqual([])
    expect(r.granted.get("editorial-desk")).toEqual([facts])
  })

  it.each([
    ["the filesystem root", () => "/", /root/],
    ["$HOME itself", () => home, /HOME/],
    ["an ancestor of $HOME", () => base, /HOME|ancestor/],
    ["~/.ssh", () => join(home, ".ssh"), /credentials directory/],
    ["~/.aws", () => join(home, ".aws"), /credentials directory/],
    ["~/.config", () => join(home, ".config"), /credentials directory/],
    ["a path under ~/.config", () => join(home, ".config", "x"), /credentials directory/],
    ["a .env file", () => join(facts, ".env"), /secrets file/],
    ["/etc", () => "/etc", /system/],
    ["a path that does not exist", () => join(home, "nope"), /does not exist/],
    ["a relative path", () => "projects/simone", /absolute/],
    ["a non-string entry", () => 42 as unknown as string, /string/],
    ["an empty string", () => "  ", /string/],
  ])("rejects %s", (_label, path, reason) => {
    const r = grantsFor({ app: [path()] })
    expect(r.granted.size).toBe(0)
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]!.reason).toMatch(reason)
  })

  it("rejects a symlink that resolves into a forbidden directory", () => {
    const sneaky = join(facts, "innocent")
    symlinkSync(join(home, ".ssh"), sneaky)
    const r = grantsFor({ app: [sneaky] })
    expect(r.granted.size).toBe(0)
    expect(r.rejected[0]!.reason).toMatch(/credentials directory/)
  })

  it("rejects the daemon workspace and any ancestor of it", () => {
    const ws = join(home, "code", "simone", "daemon-ws")
    mkdirSync(ws, { recursive: true })
    const r = grantsFor({ app: [ws, facts, join(home, "code")] }, { daemonWorkspace: ws })
    expect(r.granted.size).toBe(0)
    expect(r.rejected).toHaveLength(3)
  })

  it("grants nothing for a malformed value instead of throwing", () => {
    expect(grantsFor(["/tmp"]).granted.size).toBe(0)
    expect(grantsFor(["/tmp"]).rejected).toHaveLength(1)
    expect(grantsFor("x").granted.size).toBe(0)
    expect(grantsFor({ app: "not-an-array" }).rejected).toHaveLength(1)
    expect(grantsFor(undefined)).toEqual({ granted: new Map(), rejected: [] })
  })

  it("logs every granted and rejected entry", () => {
    const lines: string[] = []
    const resolve = createAppReadGrantResolver(
      { "editorial-desk": [facts, join(home, ".ssh")] },
      { home, log: l => lines.push(l) },
    )
    expect(resolve("editorial-desk")).toEqual([facts])
    expect(resolve("someone-else")).toEqual([])
    expect(lines.some(l => l.includes("granted READ-ONLY") && l.includes(facts) && l.includes("editorial-desk"))).toBe(true)
    expect(lines.some(l => l.includes("REJECTED") && l.includes(".ssh"))).toBe(true)
  })
})

describe("secret detection", () => {
  it("classifies secret file names, not templates", () => {
    for (const n of [".env", ".env.local", ".env.production", "id_rsa", "server.pem", "x.key", ".npmrc", "credentials.json"]) {
      expect(isSecretFileName(n), n).toBe(true)
    }
    for (const n of [".env.example", ".env.sample", "README.md", "keyboard.ts", "facts.md"]) {
      expect(isSecretFileName(n), n).toBe(false)
    }
  })

  it("finds secret files and dirs inside a tree, skipping node_modules and symlinks", () => {
    mkdirSync(join(facts, "sub", ".aws"), { recursive: true })
    writeFileSync(join(facts, "sub", ".aws", "credentials"), "x")
    mkdirSync(join(facts, "node_modules", "p"), { recursive: true })
    writeFileSync(join(facts, "node_modules", "p", ".env"), "x")
    writeFileSync(join(facts, "deploy.pem"), "x")
    symlinkSync(join(home, ".ssh"), join(facts, "ssh-link"))
    expect(findSecretsInTree(facts).sort()).toEqual(
      [join(facts, ".env"), join(facts, "deploy.pem"), join(facts, "sub", ".aws")].sort(),
    )
  })
})

describe("buildAppBoundary with operator grants", () => {
  const app = () => ({ appId: "editorial-desk", dir: appDir, dataDir: join(appDir, "data") })

  it("no grant = identical to today's boundary", () => {
    const without = buildAppBoundary({ app: app() })
    expect(buildAppBoundary({ app: app(), readGrants: [] })).toEqual(without)
    expect(without.readGrants).toBeUndefined()
    expect(without.unreadable).toBeUndefined()
    expect(without.readOnly).toEqual([appDir])
    expect(() => resolveBoundaryPath(without, join(facts, "docs", "facts.md"), "read")).toThrow(/outside the app boundary/)
  })

  it("a grant is readable and never writable; secrets inside stay refused", () => {
    const b = buildAppBoundary({ app: app(), readGrants: [facts] })
    expect(b.readOnly).toEqual([appDir, facts])
    expect(b.writable).not.toContain(facts)
    expect(b.readGrants).toEqual([facts])
    const doc = join(facts, "docs", "facts.md")
    expect(resolveBoundaryPath(b, doc, "read")).toBe(doc)
    expect(() => resolveBoundaryPath(b, doc, "write")).toThrow(/read-only/)
    expect(() => resolveBoundaryPath(b, join(facts, "docs", "new.md"), "write")).toThrow(FsZoneError)
    expect(() => resolveBoundaryPath(b, join(facts, ".env"), "read")).toThrow(/protected secret/)
    expect(resolveBoundaryPath(b, join(facts, ".env.example"), "read")).toBe(join(facts, ".env.example"))
    expect(() => resolveBoundaryPath(b, join(home, ".ssh", "id_rsa"), "read")).toThrow(/outside the app boundary/)
    expect(describeBoundary(b)).toContain(`operator-granted read-only: ${facts}`)
  })

  it("a secret reached through a symlink inside the grant is still refused", () => {
    const b = buildAppBoundary({ app: app(), readGrants: [facts] })
    symlinkSync(join(facts, ".env"), join(facts, "docs", "innocent.txt"))
    expect(() => resolveBoundaryPath(b, join(facts, "docs", "innocent.txt"), "read")).toThrow(/protected secret/)
  })

  it("grants and secrets round-trip through session meta and reach the sandbox zones", () => {
    const b = buildAppBoundary({ app: app(), readGrants: [facts] })
    expect(boundaryFromMeta(boundaryMeta(b))).toEqual(b)
    const zones = boundaryToSandboxZones(b)
    expect(zones.readOnly).toContain(facts)
    expect(zones.writable).not.toContain(facts)
    expect(zones.unreadable).toEqual([join(facts, ".env")])
    expect(boundaryToSandboxZones(buildAppBoundary({ app: app() }))).not.toHaveProperty("unreadable")
    expect(boundaryFromMeta({ appBoundary: JSON.stringify({ ...b, readGrants: "/" }) })).toBeUndefined()
  })

  it("an app cannot declare its own grant: nothing on the app object is consulted", () => {
    const selfDeclared = {
      ...app(),
      readGrants: [facts],
      externalReadRoots: [facts],
      boundaries: { enforce: "best-effort", readGrants: [facts], readOnly: [facts], extraReadOnly: [facts] },
      operatorReadGrants: [facts],
    }
    const b = buildAppBoundary({ app: selfDeclared as never })
    expect(b.readOnly).toEqual([appDir])
    expect(b.readGrants).toBeUndefined()
    expect(() => resolveBoundaryPath(b, join(facts, "docs", "facts.md"), "read")).toThrow(/outside the app boundary/)
  })

  it("a resolver keyed to another app id grants nothing to this one", () => {
    const resolve = createAppReadGrantResolver({ "someone-else": [facts] }, { home, log: () => {} })
    const b = buildAppBoundary({ app: app(), readGrants: resolve("editorial-desk") })
    expect(b.readOnly).toEqual([appDir])
  })
})

describe("apps.readGrants in the config registry", () => {
  it("is hand-edit only (config_set refuses it), restart-applied, and schema-valid", () => {
    const entry = findConfigKey("apps.readGrants.editorial-desk")
    expect(entry).toMatchObject({ writable: false, apply: "restart" })
    // The config_set path (writability checked) refuses; the owner's CLI path accepts a well-typed value.
    expect(validateConfigKeyValue("apps.readGrants.editorial-desk", ["/x"]).ok).toBe(false)
    expect(validateConfigKeyType("apps.readGrants.editorial-desk", ["/x"]).ok).toBe(true)
    expect(validateConfigKeyType("apps.readGrants.editorial-desk", "/x").ok).toBe(false)
    expect(agentprotoConfigSchema.safeParse({ apps: { readGrants: { a: ["/x"] } } }).success).toBe(true)
    expect(agentprotoConfigSchema.safeParse({ apps: { readGrants: { a: "/x" } } }).success).toBe(false)
  })
})

// Real OS confinement. Bases live under the REAL home: the vitest setup fakes
// $HOME into the temp dir, which the sandbox treats as writable scratch.
function probeSandbox(): boolean {
  const sb = resolveCommandSandbox()
  if (!sb || process.platform !== "darwin") return false
  try {
    const argv = sb.wrap(["/usr/bin/true"], { workspace: tmpdir(), extraReadPaths: [], network: "allow" })
    execFileSync(argv[0]!, argv.slice(1), { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}
const canRunSandbox = probeSandbox()

describe.skipIf(!canRunSandbox)("operator grant under the Seatbelt sandbox", () => {
  let realBase: string
  beforeEach(() => {
    realBase = realpathSync(mkdtempSync(join(userInfo().homedir, ".agentproto-appgrants-")))
  })
  afterEach(() => {
    rmSync(realBase, { recursive: true, force: true })
  })

  it("reads the grant, cannot write it, cannot read the secret inside it, and still cannot read the rest of the repo", () => {
    const repo = join(realBase, "repo")
    const app = join(repo, "apps", "editorial-desk")
    const granted = join(repo, "simone")
    const other = join(repo, "other")
    mkdirSync(app, { recursive: true })
    mkdirSync(granted, { recursive: true })
    mkdirSync(other, { recursive: true })
    execFileSync("git", ["init", "-q", repo])
    writeFileSync(join(granted, "facts.md"), "facts")
    writeFileSync(join(granted, ".env"), "SECRET=1")
    writeFileSync(join(other, "private.md"), "private")
    writeFileSync(join(repo, "root-secret.md"), "root")

    const b = buildAppBoundary({ app: { appId: "editorial-desk", dir: app }, readGrants: [granted] })
    expect(b.hidden).toContain(repo)
    const zones = boundaryToSandboxZones(b)
    const sb = resolveCommandSandbox()!
    const run = (...argv: string[]): boolean => {
      const wrapped = sb.wrap(argv, { workspace: app, extraReadPaths: [], zones, network: "allow" })
      try {
        execFileSync(wrapped[0]!, wrapped.slice(1), { stdio: "pipe" })
        return true
      } catch {
        return false
      }
    }
    expect(run("/bin/cat", join(granted, "facts.md"))).toBe(true)
    expect(run("/bin/sh", "-c", `echo pwned > '${join(granted, "facts.md")}'`)).toBe(false)
    expect(run("/usr/bin/touch", join(granted, "new.md"))).toBe(false)
    expect(run("/bin/rm", join(granted, "facts.md"))).toBe(false)
    expect(readFileSync(join(granted, "facts.md"), "utf8")).toBe("facts")
    expect(run("/bin/cat", join(granted, ".env"))).toBe(false)
    expect(run("/bin/cat", join(other, "private.md"))).toBe(false)
    expect(run("/bin/cat", join(repo, "root-secret.md"))).toBe(false)

    // Without the grant the same path is unreachable (today's behavior).
    const plain = boundaryToSandboxZones(buildAppBoundary({ app: { appId: "editorial-desk", dir: app } }))
    const wrapped = sb.wrap(["/bin/cat", join(granted, "facts.md")], { workspace: app, extraReadPaths: [], zones: plain, network: "allow" })
    expect(() => execFileSync(wrapped[0]!, wrapped.slice(1), { stdio: "pipe" })).toThrow()
  })
})

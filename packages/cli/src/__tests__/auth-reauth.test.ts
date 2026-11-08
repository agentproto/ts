/**
 * `agentproto auth reauth`, plus the expiry/state fields of `auth profile list`
 * and `auth status`. Driven through the public `runAuth` entrypoint with a fake
 * re-login adapter registered for the source, so no real login is ever run and
 * no real credential is read. All identities are example.test placeholders.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  KeychainStore,
  addAuthProfile,
  registerReauthAdapter,
  unregisterReauthAdapter,
  type ParentAccountInfo,
  type ReauthAdapter,
  type ReauthLoginPlan,
} from "@agentproto/auth"
import { runAuth } from "../commands/auth.js"
import { setReauthRunDepsForTests } from "../reauth/run.js"

const NOW = Date.now()
const HOUR = 3_600_000
const SOURCE = "opencode-console"

let prevHome: string | undefined
let home: string
let parent: ParentAccountInfo
let loginRuns: Array<{ command: string; args: string[] }>
let manualLoginDone: boolean

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-auth-reauth-"))
  process.env.HOME = home
  parent = {
    loggedIn: true,
    id: "acc_1",
    label: "user1@example.test",
    expiresAtMs: NOW - 2 * HOUR,
    fingerprint: "before",
    activeAccountId: "acc_2",
  }
  loginRuns = []
  manualLoginDone = false
  vi.spyOn(KeychainStore.prototype, "read").mockResolvedValue(undefined)
  for (const id of ["ws-a", "ws-b"]) {
    await addAuthProfile({
      id,
      endpoint: "opencode-go",
      method: "api-key",
      source: SOURCE,
      subaccount: { kind: "org", id: `org_${id}` },
    })
  }
  await addAuthProfile({ id: "plain-key", endpoint: "anthropic", method: "api-key", credentialRef: "agentproto.auth.anthropic" })
})

afterEach(async () => {
  unregisterReauthAdapter(SOURCE)
  unregisterReauthAdapter("fake-manual")
  setReauthRunDepsForTests(undefined)
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function capture() {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, "write").mockImplementation(c => (out.push(String(c)), true))
  vi.spyOn(process.stderr, "write").mockImplementation(c => (err.push(String(c)), true))
  return { out, err, text: () => out.join(""), errText: () => err.join("") }
}

function fakeAdapter(over: Partial<ReauthAdapter> = {}): ReauthAdapter {
  return {
    source: SOURCE,
    displayName: "OpenCode console",
    scopeNote: "one re-login fixes every sub-account profile under this parent",
    inspect: async () => ({ ...parent }),
    plan: () => ({ kind: "command", command: "opencode", args: ["console", "login"], description: "console login" }),
    verify: async (_t, before) => {
      const problems = before.fingerprint === parent.fingerprint ? ["no stored session changed"] : []
      return {
        status: problems.length > 0 ? "failed" : "verified",
        checked: problems.length > 0 ? [] : ["the owner's session was replaced"],
        notChecked: ["that the provider accepts the new login"],
        problems,
        sideEffects: ["the active account moved"],
        parent: { ...parent },
      }
    },
    ...over,
  }
}

/** The "login": replaces the stored session, as the real one does. */
function installLoginThatRenews() {
  setReauthRunDepsForTests({
    runLogin: async plan => {
      loginRuns.push({ command: plan.command, args: plan.args })
      parent = { ...parent, fingerprint: "after", expiresAtMs: NOW + 48 * HOUR }
      return 0
    },
  })
}

describe("agentproto auth reauth", () => {
  it("re-logs the PARENT of a sub-account profile in, verifies, and reports what it did", async () => {
    registerReauthAdapter(fakeAdapter())
    installLoginThatRenews()
    const c = capture()
    const code = await runAuth(["reauth", "ws-a"])
    expect(code).toBe(0)
    expect(loginRuns).toEqual([{ command: "opencode", args: ["console", "login"] }])
    const text = c.text()
    expect(text).toContain('the parent account behind profile "ws-a"')
    expect(text).toContain("Verification: VERIFIED")
    expect(text).toContain("checked:     the owner's session was replaced")
    expect(text).toContain("not checked: that the provider accepts the new login")
    expect(text).toContain("side effect: the active account moved")
    expect(text).toContain("Profiles under this parent: ws-a, ws-b")
    expect(text).toContain("one re-login fixes every sub-account profile under this parent")
    expect(text).not.toContain("fingerprint")
  })

  it("accepts a bare parent name and an alias", async () => {
    registerReauthAdapter(fakeAdapter({ aliases: ["oc"] }))
    installLoginThatRenews()
    capture()
    const expired = { ...parent }
    expect(await runAuth(["reauth", SOURCE])).toBe(0)
    parent = expired
    expect(await runAuth(["reauth", "oc"])).toBe(0)
    expect(loginRuns).toHaveLength(2)
  })

  it("exits 1 when verification fails, without claiming success", async () => {
    registerReauthAdapter(fakeAdapter())
    setReauthRunDepsForTests({ runLogin: async () => 0 }) // the login changed nothing
    const c = capture()
    expect(await runAuth(["reauth", "ws-a"])).toBe(1)
    expect(c.text()).toContain("Verification: FAILED")
    expect(c.text()).toContain("PROBLEM:     no stored session changed")
  })

  it("exits 1 and verifies nothing when the login command itself fails", async () => {
    const verify = vi.fn()
    registerReauthAdapter(fakeAdapter({ verify }))
    setReauthRunDepsForTests({ runLogin: async () => 7 })
    const c = capture()
    expect(await runAuth(["reauth", "ws-a"])).toBe(1)
    expect(verify).not.toHaveBeenCalled()
    expect(c.errText()).toContain("exited 7; nothing was verified")
  })

  it("--json: machine-readable report on stdout, no fingerprint or token, login chatter on stderr", async () => {
    registerReauthAdapter(fakeAdapter())
    installLoginThatRenews()
    const c = capture()
    expect(await runAuth(["reauth", "ws-a", "--json"])).toBe(0)
    const report = JSON.parse(c.text())
    expect(report).toMatchObject({
      target: "ws-a",
      source: SOURCE,
      ran: true,
      exitCode: 0,
      profiles: ["ws-a", "ws-b"],
      verification: { status: "verified", problems: [] },
      parent: {
        before: { id: "acc_1", label: "user1@example.test", state: "expired" },
        after: { id: "acc_1", state: "ok" },
      },
    })
    expect(JSON.stringify(report)).not.toContain('"fingerprint"')
    expect(c.errText()).toContain("Re-login for OpenCode console")
  })

  describe("--check", () => {
    it("is read-only: exits 1 for an expired login, 0 for a valid one, and never runs the login", async () => {
      registerReauthAdapter(fakeAdapter())
      const runLogin = vi.fn(async () => 0)
      setReauthRunDepsForTests({ runLogin })
      const c = capture()
      expect(await runAuth(["reauth", "ws-a", "--check"])).toBe(1)
      expect(c.text()).toContain("[expired]")
      expect(c.text()).toContain("login: opencode console login")
      expect(c.text()).toContain("run: agentproto auth reauth ws-a")
      parent = { ...parent, expiresAtMs: NOW + 48 * HOUR }
      expect(await runAuth(["reauth", "ws-a", "--check"])).toBe(0)
      expect(runLogin).not.toHaveBeenCalled()
    })

    it("a missing login is expired with a note", async () => {
      parent = { loggedIn: false, note: "no console login is stored" }
      registerReauthAdapter(fakeAdapter())
      const c = capture()
      expect(await runAuth(["reauth", "ws-a", "--check", "--json"])).toBe(1)
      expect(JSON.parse(c.text()).parent).toMatchObject({ loggedIn: false, state: "expired", expiresAt: null })
    })
  })

  describe("a source whose CLI cannot be driven", () => {
    const manual: ReauthLoginPlan = { kind: "manual", instructions: "Run `fake` and sign in." }
    beforeEach(async () => {
      registerReauthAdapter(fakeAdapter({ source: "fake-manual", plan: () => manual }))
      await addAuthProfile({ id: "m1", endpoint: "e", method: "oauth-bearer", source: "fake-manual" })
    })

    it("without a terminal: prints the instructions and exits 3", async () => {
      setReauthRunDepsForTests({ confirmManual: async () => false })
      const c = capture()
      expect(await runAuth(["reauth", "m1"])).toBe(3)
      expect(c.errText()).toContain("Run `fake` and sign in.")
      expect(c.errText()).toContain("agentproto auth reauth m1 --check")
    })

    it("with the operator's confirmation: verifies afterwards", async () => {
      setReauthRunDepsForTests({
        confirmManual: async () => {
          manualLoginDone = true
          parent = { ...parent, fingerprint: "after", expiresAtMs: NOW + 48 * HOUR }
          return true
        },
      })
      capture()
      expect(await runAuth(["reauth", "m1"])).toBe(0)
      expect(manualLoginDone).toBe(true)
    })
  })

  describe("usage errors exit 2", () => {
    it("no target, two targets, unknown target, a profile that holds a key", async () => {
      registerReauthAdapter(fakeAdapter())
      const c = capture()
      expect(await runAuth(["reauth"])).toBe(2)
      expect(await runAuth(["reauth", "a", "b"])).toBe(2)
      expect(await runAuth(["reauth", "no-such-thing"])).toBe(2)
      expect(c.errText()).toContain('no auth profile or parent named "no-such-thing"')
      expect(await runAuth(["reauth", "plain-key"])).toBe(2)
      expect(c.errText()).toContain('profile "plain-key" holds a stored key, not a login')
    })
  })
})

describe("expiry in auth profile list and auth status", () => {
  it("profile list --json: sub-account profiles carry their parent's expiry, state and id, never a token", async () => {
    parent = { ...parent, expiresAtMs: NOW + 2 * HOUR }
    registerReauthAdapter(fakeAdapter())
    const c = capture()
    expect(await runAuth(["profile", "list", "--json"])).toBe(0)
    const { profiles } = JSON.parse(c.text()) as { profiles: Array<Record<string, any>> }
    const a = profiles.find(p => p.id === "ws-a")!
    expect(a).toMatchObject({
      expiresAt: new Date(NOW + 2 * HOUR).toISOString(),
      state: "expiring",
      parent: { source: SOURCE, id: "acc_1", label: "user1@example.test", loggedIn: true },
      subaccount: { kind: "org", id: "org_ws-a" },
    })
    expect(profiles.find(p => p.id === "ws-b")!.parent.id).toBe("acc_1")
    // a stored-key profile has no parent account: unknown, no parent
    const plain = profiles.find(p => p.id === "plain-key")!
    expect(plain).toMatchObject({ expiresAt: null, state: "unknown" })
    expect(plain).not.toHaveProperty("parent")
    expect(c.text()).not.toMatch(/accessToken|access_token|refresh_token|refreshToken/i)
  })

  it("profile list table: an expired parent shows its state, the age and the command that fixes it", async () => {
    registerReauthAdapter(fakeAdapter())
    const c = capture()
    expect(await runAuth(["profile", "list"])).toBe(0)
    expect(c.text()).toMatch(/auth: expired \(expired 2h ago\)  parent: user1@example.test  -> agentproto auth reauth ws-a/)
  })

  it("status --json lists profiles with a login and their derived state", async () => {
    parent = { ...parent, expiresAtMs: NOW + 72 * HOUR }
    registerReauthAdapter(fakeAdapter())
    const c = capture()
    expect(await runAuth(["status", "--json"])).toBe(0)
    const body = JSON.parse(c.text())
    expect(body.hosts).toEqual([])
    expect(body.profiles.map((p: { id: string }) => p.id).sort()).toEqual(["ws-a", "ws-b"])
    expect(body.profiles[0]).toMatchObject({ source: SOURCE, state: "ok", parent: { id: "acc_1" } })
  })

  it("status table: names the profiles with a login and flags an expired one", async () => {
    registerReauthAdapter(fakeAdapter())
    const c = capture()
    expect(await runAuth(["status"])).toBe(0)
    expect(c.text()).toContain("Profiles with a login:")
    expect(c.text()).toMatch(/✗  ws-a  opencode-go  expired/)
  })
})

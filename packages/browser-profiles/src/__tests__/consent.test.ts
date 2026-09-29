import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AGENT_GRANT_REFUSED_CODE,
  CONSENT_REQUIRED_CODE,
  FULL_PROFILE_WARNING,
  AgentGrantRefusedError,
  ConsentDeclinedError,
  ConsentRequiredError,
  FullProfileGrantError,
  GrantDomainError,
  LedgerRecordInvalidError,
  NonInteractiveConsentError,
  SinkAckRequiredError,
  createAgentConsentSurface,
  createConsentHost,
  createConsentLedger,
  fileGrantStore,
  fileSessionStore,
  ledgerRecordSchema,
  localChromePort,
  memoryGrantStore,
  runDoctor,
  validateGrantDomains,
  type ConsentHost,
  type ConsentPrompt,
  type ConsentQuestion,
  type DoctorPort,
} from "../index.js"
import { makeSyntheticChromeRoot, SYNTH_PASSWORD, sqliteAvailable } from "./synthetic-chrome.js"

const CANARY = "CANARY-cookie-value-9f3a71c2"
const CANARY_B = "CANARY-other-value-b81d40e5"
const posix = process.platform !== "win32"
const modeOf = (p: string): number => statSync(p).mode & 0o777

describe("validateGrantDomains", () => {
  it.each([
    ["*", "wildcard"],
    ["*.github.com", "wildcard"],
    [".github.com", "leading-dot"],
    ["com", "bare-tld"],
    ["co.uk", "public-suffix"],
    ["not a.host", "invalid"],
  ] as const)("rejects %s as %s", (input, reason) => {
    expect(() => validateGrantDomains([input])).toThrow(GrantDomainError)
    try {
      validateGrantDomains([input])
    } catch (e) {
      expect((e as GrantDomainError).reason).toBe(reason)
    }
  })

  it("rejects an empty list", () => {
    expect(() => validateGrantDomains([])).toThrow(GrantDomainError)
    try {
      validateGrantDomains([])
    } catch (e) {
      expect((e as GrantDomainError).reason).toBe("empty")
    }
  })

  it("lowercases and de-duplicates explicit domains", () => {
    expect(validateGrantDomains(["GitHub.com", "github.com", "npmjs.com"])).toEqual(["github.com", "npmjs.com"])
  })
})

describe.skipIf(!sqliteAvailable())("consent host", () => {
  const cleanup: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "bp-consent-"))
    cleanup.push(d)
    return d
  }
  let chromeRoot: string
  let work: string
  let host: ConsentHost
  let ledgerPath: string
  let sessionsDir: string
  let jarDir: string
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>
  const asked: ConsentQuestion[] = []

  const mkHost = (over: { prompt?: ConsentPrompt; isDevicePaired?: (d: string) => boolean } = {}): ConsentHost =>
    createConsentHost({
      grants: fileGrantStore(join(work, "grants.json")),
      ledger: createConsentLedger({ path: ledgerPath }),
      store: fileSessionStore(sessionsDir),
      jarDir,
      chrome: localChromePort({ chromeRoot, safeStoragePassword: () => SYNTH_PASSWORD }),
      ...over,
    })

  beforeEach(() => {
    asked.length = 0
    chromeRoot = makeSyntheticChromeRoot([
      {
        dir: "Default",
        cookies: [
          { host: ".github.com", name: "user_session", value: CANARY, secure: true, httpOnly: true },
          { host: "gist.github.com", name: "gist_pref", value: "x1" },
          { host: ".npmjs.com", name: "npm_session", value: CANARY_B },
          { host: ".bank.example", name: "bank_token", value: "must-never-be-read" },
        ],
      },
      { dir: "Profile 1", cookies: [{ host: ".github.com", name: "other", value: "y" }] },
    ])
    cleanup.push(chromeRoot)
    work = tmp()
    ledgerPath = join(work, "bureau", "consent.jsonl")
    sessionsDir = join(work, "sessions")
    jarDir = join(work, "jars")
    host = mkHost()
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
    errSpy.mockRestore()
    for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const ledgerText = (): string => (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "")
  const rows = () => createConsentLedger({ path: ledgerPath }).read()

  describe("non-interactive import (C4)", () => {
    it("fails without --domains and --yes, naming both, and writes nothing", async () => {
      await expect(host.importFromChrome({ sessionId: "s1", profile: "Default" })).rejects.toBeInstanceOf(NonInteractiveConsentError)
      const err = await host.importFromChrome({ sessionId: "s1", profile: "Default" }).catch((e: unknown) => e)
      expect((err as NonInteractiveConsentError).missing).toEqual(["--domains", "--yes"])
      expect(existsSync(ledgerPath)).toBe(false)
      expect(host.listGrants()).toEqual([])
    })

    it("fails with domains but no --yes", async () => {
      const err = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"] }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(NonInteractiveConsentError)
      expect((err as NonInteractiveConsentError).missing).toEqual(["--yes"])
      expect(existsSync(ledgerPath)).toBe(false)
    })

    it("fails with --yes but no domains", async () => {
      const err = await host.importFromChrome({ sessionId: "s1", profile: "Default", yes: true }).catch((e: unknown) => e)
      expect((err as NonInteractiveConsentError).missing).toEqual(["--domains"])
    })

    it("rejects a wildcard even with --yes", async () => {
      await expect(host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["*"], yes: true })).rejects.toBeInstanceOf(GrantDomainError)
      await expect(host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["*.github.com"], yes: true })).rejects.toBeInstanceOf(GrantDomainError)
      await expect(host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["com"], yes: true })).rejects.toBeInstanceOf(GrantDomainError)
      expect(host.listGrants()).toEqual([])
    })

    it("imports exactly the named domains with --domains and --yes", async () => {
      const res = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      expect(res.grant.domains).toEqual(["github.com"])
      expect(res.grant.grantedVia).toBe("flag")
      expect(res.grant.cookieCount).toBe(2)
      expect(res.presence).toEqual({ "github.com": 2 })
      const cookies = host.cookieSourceFor()({ providerId: "chromium", profile: "s1" })
      const names = cookies.map(c => c.name).sort()
      expect(names).toEqual(["gist_pref", "user_session"])
    })
  })

  describe("interactive consent", () => {
    it("asks once per domain with counts only, and a decline aborts the grant", async () => {
      const prompt: ConsentPrompt = {
        confirm: async q => {
          asked.push(q)
          return q.kind === "domain" ? q.domain === "github.com" : false
        },
      }
      const h = mkHost({ prompt })
      await expect(
        h.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com", "npmjs.com"] }),
      ).rejects.toBeInstanceOf(ConsentDeclinedError)
      expect(asked.map(q => (q.kind === "domain" ? q.domain : q.kind))).toEqual(["github.com", "npmjs.com"])
      expect(JSON.stringify(asked)).not.toContain(CANARY)
      expect(h.listGrants()).toEqual([])
      expect(existsSync(ledgerPath)).toBe(false)
    })

    it("records an interactive grant when every domain is approved", async () => {
      const h = mkHost({ prompt: { confirm: async () => true } })
      const res = await h.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"] })
      expect(res.grant.grantedVia).toBe("interactive")
      expect(rows()[0]?.actor.via).toBe("interactive")
    })

    it("still rejects an empty list interactively (no default of all)", async () => {
      const h = mkHost({ prompt: { confirm: async () => true } })
      await expect(h.importFromChrome({ sessionId: "s1", profile: "Default" })).rejects.toBeInstanceOf(GrantDomainError)
    })
  })

  describe("remote sink (C6)", () => {
    it("refuses a remote sink without an acknowledgement, even with --yes", async () => {
      await expect(
        host.importFromChrome({
          sessionId: "s1",
          profile: "Default",
          domains: ["github.com"],
          yes: true,
          sinks: [{ kind: "remote", providerId: "e2b" }],
        }),
      ).rejects.toBeInstanceOf(SinkAckRequiredError)
      expect(host.listGrants()).toEqual([])
      expect(existsSync(ledgerPath)).toBe(false)
    })

    it("records a sink-ack row and its seq as ackSeq when acknowledged", async () => {
      const res = await host.importFromChrome({
        sessionId: "s1",
        profile: "Default",
        domains: ["github.com"],
        yes: true,
        sinks: [{ kind: "remote", providerId: "e2b", acknowledged: true }],
      })
      const ack = rows().find(r => r.event === "sink-ack")
      expect(ack).toBeDefined()
      expect(ack?.sinkId).toBe("e2b")
      expect(res.grant.sinks).toContainEqual({ kind: "remote", providerId: "e2b", ackSeq: ack?.seq })
    })

    it("asks the human to acknowledge a remote sink when a prompt exists", async () => {
      const seen: string[] = []
      const h = mkHost({
        prompt: {
          confirm: async q => {
            seen.push(q.kind)
            return q.kind !== "sink"
          },
        },
      })
      await expect(
        h.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], sinks: [{ kind: "remote", providerId: "e2b" }] }),
      ).rejects.toBeInstanceOf(SinkAckRequiredError)
      expect(seen).toEqual(["domain", "sink"])
    })
  })

  describe("ledger file", () => {
    it("is created 0600 in a 0700 dir", async () => {
      await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      expect(existsSync(ledgerPath)).toBe(true)
      if (posix) {
        expect(modeOf(ledgerPath)).toBe(0o600)
        expect(modeOf(join(work, "bureau"))).toBe(0o700)
      }
    })

    it("keeps grants and jars private too", async () => {
      await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      if (posix) {
        expect(modeOf(join(work, "grants.json"))).toBe(0o600)
        expect(modeOf(jarDir)).toBe(0o700)
        const grant = host.listGrants()[0]
        expect(grant && modeOf(join(jarDir, `${grant.id}.json`))).toBe(0o600)
      }
    })

    it("chains rows with monotonic seq and a prev hash", async () => {
      await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      await host.importFromChrome({ sessionId: "s2", profile: "Default", domains: ["npmjs.com"], yes: true })
      const r = rows()
      expect(r.map(x => x.seq)).toEqual([0, 1])
      expect(r[0]?.prev).toBeUndefined()
      expect(r[1]?.prev).toMatch(/^[0-9a-f]{64}$/)
      expect(createConsentLedger({ path: ledgerPath }).verifyChain()).toBe(true)
    })

    it("detects a tampered row", async () => {
      await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      await host.importFromChrome({ sessionId: "s2", profile: "Default", domains: ["npmjs.com"], yes: true })
      writeFileSync(ledgerPath, ledgerText().replace('"s1"', '"sX"'))
      expect(createConsentLedger({ path: ledgerPath }).verifyChain()).toBe(false)
    })

    it("stores salted name hashes, never names or values", async () => {
      const res = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      const row = rows()[0]
      expect(row?.nameHashes).toHaveLength(2)
      expect(ledgerText()).not.toContain("user_session")
      expect(res.grant.id).toBeTruthy()
    })

    it("rejects an agent grant record and any record with an extra (value) field", () => {
      const ledger = createConsentLedger({ path: ledgerPath })
      expect(() =>
        ledger.append({ event: "grant", actor: { kind: "agent" }, grantId: "g", sessionId: "s", domains: ["github.com"], cookieCount: 1 }),
      ).toThrow(LedgerRecordInvalidError)
      const withValue = {
        seq: 0,
        at: new Date().toISOString(),
        event: "grant",
        actor: { kind: "human" },
        grantId: "g",
        sessionId: "s",
        domains: ["github.com"],
        cookieCount: 1,
        cookies: [{ name: "a", value: CANARY }],
      }
      expect(ledgerRecordSchema.safeParse(withValue).success).toBe(false)
      expect(existsSync(ledgerPath)).toBe(false)
    })
  })

  describe("revoke (C8)", () => {
    it("deletes the derived store state and appends a revoke row, read back from both", async () => {
      const store = fileSessionStore(sessionsDir)
      const { grant } = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      const jarFile = join(jarDir, `${grant.id}.json`)
      expect(existsSync(jarFile)).toBe(true)
      expect(await store.load("s1")).not.toBeNull()

      const res = await host.revoke(grant.id)

      expect(res.derived).toEqual({ local: "deleted", remote: "not-applicable" })
      expect(existsSync(jarFile)).toBe(false)
      expect(await store.load("s1")).toBeNull()
      expect(await store.list()).toEqual([])
      expect(host.getGrant(grant.id)?.revokedAt).toBeDefined()
      expect(host.cookieSourceFor()({ providerId: "chromium", profile: "s1" })).toEqual([])

      const revoke = rows().find(r => r.event === "revoke")
      expect(revoke).toMatchObject({ grantId: grant.id, sessionId: "s1", actor: { kind: "human" }, derived: { local: "deleted", remote: "not-applicable" } })
      expect(rows().map(r => r.event)).toEqual(["grant", "revoke"])
      expect(createConsentLedger({ path: ledgerPath }).verifyChain()).toBe(true)
    })

    it("leaves the descriptor of a session that still has another active grant", async () => {
      const store = fileSessionStore(sessionsDir)
      const a = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      const b = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["npmjs.com"], yes: true })
      await host.revoke(b.grant.id)
      const desc = await store.load("s1")
      expect(desc?.inject).toMatchObject({ from: "file", domains: ["github.com"] })
      expect(host.cookieSourceFor()({ providerId: "chromium", profile: "s1" }).length).toBe(2)
      expect(a.grant.id).not.toBe(b.grant.id)
    })

    it("records the remote outcome as unavailable when no remote revoker is wired", async () => {
      const { grant } = await host.importFromChrome({
        sessionId: "s1",
        profile: "Default",
        domains: ["github.com"],
        yes: true,
        sinks: [{ kind: "remote", providerId: "e2b", acknowledged: true }],
      })
      const res = await host.revoke(grant.id)
      expect(res.derived.remote).toBe("unavailable")
    })

    it("is idempotent and writes one revoke row", async () => {
      const { grant } = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      await host.revoke(grant.id)
      await host.revoke(grant.id)
      expect(rows().filter(r => r.event === "revoke")).toHaveLength(1)
    })
  })

  describe("cookie values never leak", () => {
    it("keeps the canary out of the ledger, logs, results and errors across the whole flow", async () => {
      const results: unknown[] = []
      const errors: unknown[] = []
      const attempt = async <T>(fn: () => Promise<T>): Promise<void> => {
        try {
          results.push(await fn())
        } catch (e) {
          errors.push({ name: (e as Error).name, message: (e as Error).message, stack: (e as Error).stack, extra: { ...(e as object) } })
        }
      }
      const imp = await host.importFromChrome({
        sessionId: "s1",
        profile: "Default",
        domains: ["github.com", "npmjs.com"],
        yes: true,
        sinks: [{ kind: "remote", providerId: "e2b", acknowledged: true }],
      })
      results.push(imp)
      const agent = createAgentConsentSurface(host)
      await attempt(() => agent.sync({ grantId: imp.grant.id }))
      await attempt(() => agent.sync({ grantId: imp.grant.id, domains: ["github.com", "bank.example"] }))
      await attempt(() => agent.grant({ sessionId: "s1", domains: ["github.com"] }))
      await attempt(() => host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["*"], yes: true }))
      await attempt(() => host.importFromChrome({ sessionId: "s1", profile: "Nope", domains: ["github.com"], yes: true }))
      await attempt(() => host.grantFullProfile({ sessionId: "s1", profile: "Default", yes: true }))
      await attempt(() => host.revoke(imp.grant.id))

      const haystack = [
        ledgerText(),
        JSON.stringify(results),
        JSON.stringify(errors),
        JSON.stringify(logSpy.mock.calls),
        JSON.stringify(warnSpy.mock.calls),
        JSON.stringify(errSpy.mock.calls),
        readFileSync(join(work, "grants.json"), "utf8"),
      ].join("\n")
      for (const canary of [CANARY, CANARY_B]) expect(haystack).not.toContain(canary)
      expect(haystack).not.toContain("must-never-be-read")
      expect(ledgerText().length).toBeGreaterThan(0)
    })

    it("only ever reads the granted domains", async () => {
      await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      const cookies = host.cookieSourceFor()({ providerId: "chromium", profile: "s1" })
      expect(cookies.map(c => c.domain).every(d => d.endsWith("github.com"))).toBe(true)
      expect(JSON.stringify(cookies)).not.toContain(CANARY_B)
      expect(JSON.stringify(cookies)).not.toContain("must-never-be-read")
      expect(cookies.find(c => c.name === "user_session")?.value).toBe(CANARY)
    })
  })

  describe("per-device grants (C12, Decision 5)", () => {
    it("serves github.com to device A and not to device B", async () => {
      const { grant } = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true, deviceId: "dev-A" })
      expect(grant.deviceId).toBe("dev-A")
      expect(rows()[0]?.actor.deviceId).toBe("dev-A")

      const a = host.cookieSourceFor({ deviceId: "dev-A" })({ providerId: "chromium", profile: "s1" })
      const b = host.cookieSourceFor({ deviceId: "dev-B" })({ providerId: "chromium", profile: "s1" })
      expect(a.length).toBe(2)
      expect(b).toEqual([])

      expect(host.assertCovered({ sessionId: "s1", host: "gist.github.com", deviceId: "dev-A" }).id).toBe(grant.id)
      expect(() => host.assertCovered({ sessionId: "s1", host: "github.com", deviceId: "dev-B" })).toThrow(ConsentRequiredError)
      try {
        host.assertCovered({ sessionId: "s1", host: "github.com", deviceId: "dev-B" })
      } catch (e) {
        expect((e as ConsentRequiredError).code).toBe(CONSENT_REQUIRED_CODE)
      }
    })

    it("does not cover a host outside the granted domains, even for device A", async () => {
      await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true, deviceId: "dev-A" })
      expect(() => host.assertCovered({ sessionId: "s1", host: "npmjs.com", deviceId: "dev-A" })).toThrow(ConsentRequiredError)
      expect(() => host.assertCovered({ sessionId: "s1", host: "notgithub.com", deviceId: "dev-A" })).toThrow(ConsentRequiredError)
    })

    it("stops honoring a device's grants once its pairing is gone (C13)", async () => {
      const paired = new Set(["dev-A"])
      const h = mkHost({ isDevicePaired: d => paired.has(d) })
      await h.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true, deviceId: "dev-A" })
      expect(h.cookieSourceFor({ deviceId: "dev-A" })({ providerId: "chromium", profile: "s1" }).length).toBe(2)
      paired.delete("dev-A")
      expect(h.cookieSourceFor({ deviceId: "dev-A" })({ providerId: "chromium", profile: "s1" })).toEqual([])
    })

    it("an unscoped grant serves any device", async () => {
      await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      expect(host.cookieSourceFor({ deviceId: "dev-B" })({ providerId: "chromium", profile: "s1" }).length).toBe(2)
    })

    it("does not serve a remote-sink-only grant to a different provider", async () => {
      await host.importFromChrome({
        sessionId: "s1",
        profile: "Default",
        domains: ["github.com"],
        yes: true,
        sinks: [{ kind: "remote", providerId: "e2b", acknowledged: true }],
      })
      const src = host.cookieSourceFor()
      expect(src({ providerId: "e2b", profile: "s1" })).toHaveLength(2)
      expect(src({ providerId: "other", profile: "s1" })).toEqual([])
    })
  })

  describe("agent surface (C7, F4)", () => {
    it("refreshes inside a grant and records an agent refresh row", async () => {
      const { grant } = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      const agent = createAgentConsentSurface(host, { via: "mcp" })
      const res = await agent.sync({ grantId: grant.id, domains: ["github.com"], profile: "Default" })
      expect(res).toEqual({ grantId: grant.id, cookieCount: 2 })
      expect(rows().at(-1)).toMatchObject({ event: "refresh", actor: { kind: "agent", via: "mcp" }, domains: ["github.com"] })
    })

    it("treats domain case and duplicates as the same set, and records refresh as a system action", async () => {
      const { grant } = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      const agent = createAgentConsentSurface(host)
      await expect(agent.sync({ grantId: grant.id, domains: ["GitHub.com", "github.com"] })).resolves.toMatchObject({ grantId: grant.id })
      await host.refresh(grant.id)
      expect(rows().at(-1)).toMatchObject({ event: "refresh", actor: { kind: "system" } })
    })

    it("serves nothing (no throw) when a cookie jar file is corrupt", async () => {
      const { grant } = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      writeFileSync(join(jarDir, `${grant.id}.json`), "{not json")
      expect(host.cookieSourceFor()({ providerId: "chromium", profile: "s1" })).toEqual([])
    })

    it("cannot add a domain: refused, appended as deny, grant unchanged", async () => {
      const { grant } = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      const agent = createAgentConsentSurface(host)
      const err = await agent.sync({ grantId: grant.id, domains: ["github.com", "npmjs.com"] }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AgentGrantRefusedError)
      expect((err as AgentGrantRefusedError).code).toBe(AGENT_GRANT_REFUSED_CODE)
      expect(host.getGrant(grant.id)?.domains).toEqual(["github.com"])
      expect(host.cookieSourceFor()({ providerId: "chromium", profile: "s1" }).every(c => c.domain.endsWith("github.com"))).toBe(true)
      expect(rows().at(-1)).toMatchObject({ event: "deny", actor: { kind: "agent" }, grantId: grant.id })
      expect(rows().at(-1)?.reason).toContain("add a domain")
    })

    it("cannot change profile: refused, appended as deny, grant unchanged", async () => {
      const { grant } = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      const agent = createAgentConsentSurface(host)
      await expect(agent.sync({ grantId: grant.id, profile: "Profile 1" })).rejects.toBeInstanceOf(AgentGrantRefusedError)
      expect(host.getGrant(grant.id)?.source.profile).toBe("Default")
      expect(rows().at(-1)).toMatchObject({ event: "deny", actor: { kind: "agent" } })
      expect(rows().at(-1)?.reason).toContain("change the Chrome profile")
    })

    it("cannot grant, add a sink, or take the human import path", async () => {
      const { grant } = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      const agent = createAgentConsentSurface(host)
      await expect(agent.grant({ sessionId: "s2", domains: ["github.com"] })).rejects.toBeInstanceOf(AgentGrantRefusedError)
      await expect(agent.addSink({ grantId: grant.id, providerId: "e2b" })).rejects.toBeInstanceOf(AgentGrantRefusedError)
      await expect(
        host.importFromChrome({ sessionId: "s3", profile: "Default", domains: ["github.com"], yes: true, actor: { kind: "agent" } }),
      ).rejects.toBeInstanceOf(AgentGrantRefusedError)
      await expect(host.grantFullProfile({ sessionId: "s3", profile: "Default", yes: true, actor: { kind: "agent" } })).rejects.toBeInstanceOf(
        AgentGrantRefusedError,
      )
      expect(host.listGrants()).toHaveLength(1)
      expect(rows().filter(r => r.event === "grant")).toHaveLength(1)
      expect(rows().filter(r => r.event === "deny")).toHaveLength(4)
    })

    it("may revoke, and cannot touch another device's grant", async () => {
      const { grant } = await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true, deviceId: "dev-A" })
      await expect(createAgentConsentSurface(host, { deviceId: "dev-B" }).sync({ grantId: grant.id })).rejects.toBeInstanceOf(ConsentRequiredError)
      await createAgentConsentSurface(host, { deviceId: "dev-A" }).revoke(grant.id)
      expect(host.getGrant(grant.id)?.revokedAt).toBeDefined()
      expect(rows().at(-1)).toMatchObject({ event: "revoke", actor: { kind: "agent", deviceId: "dev-A" } })
    })
  })

  describe("full profile (C3, F11)", () => {
    it("is refused without an explicit --yes when non-interactive, and writes nothing", async () => {
      await expect(host.grantFullProfile({ sessionId: "s1", profile: "Default" })).rejects.toBeInstanceOf(NonInteractiveConsentError)
      expect(existsSync(ledgerPath)).toBe(false)
    })

    it("proof is refused without a grant and unlocks with one, then locks again on revoke", async () => {
      expect(() => host.fullProfileProof({ sessionId: "s1", profile: "Default" })).toThrow(FullProfileGrantError)

      const res = await host.grantFullProfile({ sessionId: "s1", profile: "Default", yes: true })
      expect(res.warning).toBe(FULL_PROFILE_WARNING)
      expect(res.warning).toMatch(/^WARNING/)
      expect(res.grant).toMatchObject({ fullProfile: true, sinks: [{ kind: "local" }], cookieCount: 4 })
      expect(res.grant.domains).toBeUndefined()
      expect(rows()[0]).toMatchObject({ event: "grant", fullProfile: true, cookieCount: 4 })
      expect(rows()[0]?.domains).toBeUndefined()

      const proof = host.fullProfileProof({ sessionId: "s1", profile: "Default" })
      expect(proof.grantId).toBe(res.grant.id)
      expect(proof.isActive()).toBe(true)

      await host.revoke(res.grant.id)
      expect(proof.isActive()).toBe(false)
      expect(() => host.fullProfileProof({ grantId: res.grant.id })).toThrow(FullProfileGrantError)
    })

    it("a domain grant is not a full-profile grant", async () => {
      await host.importFromChrome({ sessionId: "s1", profile: "Default", domains: ["github.com"], yes: true })
      expect(() => host.fullProfileProof({ sessionId: "s1", profile: "Default" })).toThrow(FullProfileGrantError)
    })

    it("does not unlock for another profile, session or device", async () => {
      await host.grantFullProfile({ sessionId: "s1", profile: "Default", yes: true, deviceId: "dev-A" })
      expect(() => host.fullProfileProof({ sessionId: "s1", profile: "Profile 1", deviceId: "dev-A" })).toThrow(FullProfileGrantError)
      expect(() => host.fullProfileProof({ sessionId: "s2", profile: "Default", deviceId: "dev-A" })).toThrow(FullProfileGrantError)
      expect(() => host.fullProfileProof({ sessionId: "s1", profile: "Default", deviceId: "dev-B" })).toThrow(FullProfileGrantError)
      expect(host.fullProfileProof({ sessionId: "s1", profile: "Default", deviceId: "dev-A" }).isActive()).toBe(true)
    })

    it("lets an expired grant lapse", async () => {
      let clock = new Date("2026-01-01T00:00:00Z")
      const h = createConsentHost({
        grants: memoryGrantStore(),
        ledger: createConsentLedger({ path: ledgerPath, now: () => clock }),
        store: fileSessionStore(sessionsDir),
        jarDir,
        chrome: localChromePort({ chromeRoot, safeStoragePassword: () => SYNTH_PASSWORD }),
        now: () => clock,
      })
      await h.grantFullProfile({ sessionId: "s1", profile: "Default", yes: true, expiresAt: "2026-01-02T00:00:00Z" })
      const proof = h.fullProfileProof({ sessionId: "s1", profile: "Default" })
      expect(proof.isActive()).toBe(true)
      clock = new Date("2026-01-03T00:00:00Z")
      expect(proof.isActive()).toBe(false)
    })
  })

  it("rejects an unknown Chrome profile and any path-shaped profile name", async () => {
    await expect(host.importFromChrome({ sessionId: "s1", profile: "../etc", domains: ["github.com"], yes: true })).rejects.toThrow(/not found/)
  })
})

describe("doctor", () => {
  const eperm = (): never => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
  }
  const okState = JSON.stringify({ profile: { info_cache: { Default: { name: "Me" } } } })
  const port = (over: Partial<DoctorPort> = {}): DoctorPort => ({
    binary: "/opt/homebrew/bin/node",
    readLocalState: () => okState,
    copyCookiesDb: () => undefined,
    ...over,
  })

  it("is green when Local State reads and the Cookies db copies, and does not touch the Keychain", () => {
    const probeKeychain = vi.fn()
    const report = runDoctor({ port: port({ probeKeychain }), profile: "Default" })
    expect(report.ok).toBe(true)
    expect(report.recommendation).toBeUndefined()
    expect(report.checks.map(c => [c.id, c.status])).toEqual([
      ["local-state", "ok"],
      ["cookies-db", "ok"],
      ["keychain", "skipped"],
    ])
    expect(probeKeychain).not.toHaveBeenCalled()
  })

  it("classifies EPERM on the Cookies db as missing Full Disk Access, naming the exact binary", () => {
    const report = runDoctor({ port: port({ copyCookiesDb: eperm }), profile: "Default" })
    const cookies = report.checks.find(c => c.id === "cookies-db")
    expect(report.ok).toBe(false)
    expect(cookies?.status).toBe("fail")
    expect(cookies?.failure).toBe("full-disk-access")
    expect(cookies?.detail).toContain("/opt/homebrew/bin/node")
    expect(cookies?.detail).toContain("Full Disk Access")
    expect(cookies?.fix).toContain("/opt/homebrew/bin/node")
  })

  it("classifies EPERM on Local State the same way", () => {
    const report = runDoctor({ port: port({ readLocalState: eperm }), profile: "Default" })
    expect(report.checks[0]).toMatchObject({ id: "local-state", status: "fail", failure: "full-disk-access" })
  })

  it("classifies a missing profile as missing, not as a permission problem", () => {
    const enoent = (): never => {
      throw Object.assign(new Error("no such file"), { code: "ENOENT" })
    }
    const report = runDoctor({ port: port({ copyCookiesDb: enoent }), profile: "Profile 9" })
    expect(report.checks.find(c => c.id === "cookies-db")).toMatchObject({ failure: "missing" })
  })

  it("classifies a corrupt Local State as unreadable", () => {
    const report = runDoctor({ port: port({ readLocalState: () => "{not json" }), profile: "Default" })
    expect(report.checks[0]).toMatchObject({ status: "fail", failure: "unreadable" })
  })

  it("recommends native login on any failure", () => {
    const report = runDoctor({ port: port({ copyCookiesDb: eperm }), profile: "Default" })
    expect(report.recommendation).toMatch(/native/i)
  })

  it("touches the Keychain only on the explicit keychain check, and never reports its value", () => {
    const probeKeychain = vi.fn()
    const report = runDoctor({ port: port({ probeKeychain }), profile: "Default", checkKeychain: true })
    expect(probeKeychain).toHaveBeenCalledTimes(1)
    expect(report.checks.find(c => c.id === "keychain")?.status).toBe("ok")
  })

  it("reports a denied Keychain without leaking the thrown message", () => {
    const probeKeychain = (): never => {
      throw new Error(`secret ${CANARY}`)
    }
    const report = runDoctor({ port: port({ probeKeychain }), profile: "Default", checkKeychain: true })
    expect(report.checks.find(c => c.id === "keychain")).toMatchObject({ status: "fail", failure: "keychain-denied" })
    expect(JSON.stringify(report)).not.toContain(CANARY)
  })
})

describe("grant store", () => {
  it("rejects a corrupt grants file with a typed error", () => {
    const dir = mkdtempSync(join(tmpdir(), "bp-gs-"))
    try {
      const p = join(dir, "grants.json")
      writeFileSync(p, "{}")
      expect(() => fileGrantStore(p).list()).toThrow(/grant list/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

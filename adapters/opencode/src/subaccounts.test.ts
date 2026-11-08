import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  migrateLegacySubaccountProfile,
  reauthHintOf,
  registerSubaccountProvider,
  SubaccountError,
  unregisterSubaccountProvider,
} from "@agentproto/auth"
import {
  OpencodeAccountExpiredError,
  OpencodeOrgOwnerNotFoundError,
  createOpencodeSubaccountProvider,
  listOpencodeConsoleOrgs,
  parseLegacyOpencodeConsoleSource,
  readOpencodeConsoleAccount,
  resolveOpencodeConsoleOrg,
} from "./subaccounts.js"

const NOW = 1_800_000_000_000
const TOKEN = "st_FAKE_ACCESS_TOKEN_0123456789"

interface Fixture {
  dir: string
  dbPath: string
}

/** A fake opencode.db carrying only the two tables the source reads. */
async function makeDb(
  opts: { expiry?: number | null; accounts?: number; activeId?: string | null } = {},
): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "oc-console-"))
  const dbPath = join(dir, "opencode.db")
  const specifier = ["node", "sqlite"].join(":")
  const { DatabaseSync } = (await import(specifier)) as typeof import("node:sqlite")
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL, url text NOT NULL,
    access_token text NOT NULL, refresh_token text NOT NULL, token_expiry integer,
    time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE account_state (id integer PRIMARY KEY NOT NULL, active_account_id text, active_org_id text);`)
  const n = opts.accounts ?? 1
  for (let i = 1; i <= n; i++) {
    db.prepare("INSERT INTO account VALUES (?,?,?,?,?,?,?,?)").run(
      `acc_${i}`,
      `user${i}@example.test`,
      "https://console.example.test/console/",
      i === 1 ? TOKEN : `st_OTHER_${i}`,
      "rt_FAKE_REFRESH",
      opts.expiry === undefined ? NOW + 3_600_000 : opts.expiry,
      1,
      1,
    )
  }
  if (n > 0) {
    db.prepare("INSERT INTO account_state VALUES (1, ?, ?)").run(
      opts.activeId === undefined ? "acc_1" : opts.activeId,
      "org_active",
    )
  }
  db.close()
  return { dir, dbPath }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("opencode console sub-account provider", () => {
  const dirs: string[] = []
  const track = (f: Fixture) => {
    dirs.push(f.dir)
    return f
  }
  beforeEach(() => {
    vi.useRealTimers()
  })
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("parses the legacy profile source into an org pin", () => {
    expect(parseLegacyOpencodeConsoleSource("opencode-console:org_01ABC")).toEqual({ kind: "org", id: "org_01ABC" })
    expect(parseLegacyOpencodeConsoleSource("opencode-console:")).toBeUndefined()
    expect(parseLegacyOpencodeConsoleSource("opencode-console")).toBeUndefined()
    expect(parseLegacyOpencodeConsoleSource("claude-code-oauth")).toBeUndefined()
    expect(parseLegacyOpencodeConsoleSource(undefined)).toBeUndefined()
  })

  it("migrates a legacy source-encoded profile to the generic shape on read", () => {
    registerSubaccountProvider(createOpencodeSubaccountProvider())
    try {
      const migrated = migrateLegacySubaccountProfile({
        id: "opencode-ws01",
        endpoint: "opencode-go",
        method: "api-key",
        source: "opencode-console:org_01ABC",
      })
      expect(migrated.source).toBe("opencode-console")
      expect(migrated.subaccount).toEqual({ kind: "org", id: "org_01ABC" })
    } finally {
      unregisterSubaccountProvider("opencode-console")
    }
  })

  it("reads the active console account from opencode.db", async () => {
    const f = track(await makeDb({ accounts: 2, activeId: "acc_2" }))
    const acc = await readOpencodeConsoleAccount({ dbPath: f.dbPath, now: () => NOW })
    expect(acc.id).toBe("acc_2")
    expect(acc.accessToken).toBe("st_OTHER_2")
    expect(acc.url).toBe("https://console.example.test/console")
  })

  it("falls back to the first account when none is marked active", async () => {
    const f = track(await makeDb({ activeId: null }))
    const acc = await readOpencodeConsoleAccount({ dbPath: f.dbPath, now: () => NOW })
    expect(acc.accessToken).toBe(TOKEN)
  })

  it("fails loud on an expired session and does not refresh it", async () => {
    const f = track(await makeDb({ expiry: NOW - 1000 }))
    const fetchSpy = vi.fn()
    await expect(
      resolveOpencodeConsoleOrg("org_a", "opencode-ws01", { dbPath: f.dbPath, now: () => NOW, fetch: fetchSpy }),
    ).rejects.toThrow(/expired/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("fails loud when there is no login or no db", async () => {
    const f = track(await makeDb({ accounts: 0 }))
    await expect(readOpencodeConsoleAccount({ dbPath: f.dbPath, now: () => NOW })).rejects.toBeInstanceOf(
      SubaccountError,
    )
    await expect(
      readOpencodeConsoleAccount({ dbPath: join(f.dir, "missing.db"), now: () => NOW }),
    ).rejects.toThrow(/unreadable/)
  })

  it("never writes to the db it reads", async () => {
    const f = track(await makeDb())
    const specifier = ["node", "sqlite"].join(":")
    const { DatabaseSync } = (await import(specifier)) as typeof import("node:sqlite")
    const before = new DatabaseSync(f.dbPath, { readOnly: true })
    const rowBefore = before.prepare("SELECT * FROM account_state").get()
    before.close()
    await readOpencodeConsoleAccount({ dbPath: f.dbPath, now: () => NOW })
    const after = new DatabaseSync(f.dbPath, { readOnly: true })
    expect(after.prepare("SELECT * FROM account_state").get()).toEqual(rowBefore)
    after.close()
  })

  it("lists the orgs through GET /api/orgs with the bearer", async () => {
    const f = track(await makeDb())
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse([
        { id: "org_a", name: "Ws01" },
        { id: "org_b", name: "Ws02" },
      ]),
    )
    const { orgs } = await listOpencodeConsoleOrgs({
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    })
    expect(orgs).toEqual([
      { id: "org_a", name: "Ws01" },
      { id: "org_b", name: "Ws02" },
    ])
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe("https://console.example.test/console/api/orgs")
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
  })

  it("resolves a pinned org: x-org-id on the config fetch, provider block as inline config, token only as the credential", async () => {
    const f = track(await makeDb())
    const provider = {
      "opencode-go": {
        options: { apiKey: "{env:OPENCODE_CONSOLE_TOKEN}", headers: { "x-opencode-org-id": "org_b" } },
      },
    }
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ config: { provider } }),
    )
    const out = await resolveOpencodeConsoleOrg("org_b", "opencode-ws02", {
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe("https://console.example.test/console/api/config")
    expect((init!.headers as Record<string, string>)["x-org-id"]).toBe("org_b")
    expect(out.credential).toBe(TOKEN)
    expect(JSON.parse(out.extraEnv.OPENCODE_CONFIG_CONTENT!)).toEqual({ provider })
    expect(JSON.stringify(out.extraEnv)).not.toContain(TOKEN)
  })

  it("names the profile and org when the config fetch fails, without leaking the token", async () => {
    const f = track(await makeDb())
    const fetchMock = vi.fn(async () => jsonResponse({ error: "forbidden" }, 403))
    const err = (await resolveOpencodeConsoleOrg("org_zzz", "opencode-ws09", {
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e as Error)) as Error
    expect(err).toBeInstanceOf(SubaccountError)
    expect(err.message).toMatch(/opencode-ws09/)
    expect(err.message).toMatch(/org_zzz/)
    expect(err.message).toMatch(/403/)
    expect(err.message).not.toContain(TOKEN)
  })

  it("rejects an org that returns no provider block (never bills an unconfigured org silently)", async () => {
    const f = track(await makeDb())
    const fetchMock = vi.fn(async () => jsonResponse({ config: {} }))
    await expect(
      resolveOpencodeConsoleOrg("org_a", "opencode-ws01", {
        dbPath: f.dbPath,
        now: () => NOW,
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/no provider config/)
  })

  it("provider.list maps the console orgs to org sub-accounts and names the login, not the token", async () => {
    const f = track(await makeDb())
    const fetchMock = vi.fn(async () => jsonResponse([{ id: "org_a", name: "Ws01" }]))
    const provider = createOpencodeSubaccountProvider({
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    })
    const listing = await provider.list({ endpoint: "opencode-go", source: "opencode-console" })
    expect(listing.account).toEqual({ id: "acc_1", label: "user1@example.test" })
    expect(listing.subaccounts).toEqual([{ kind: "org", id: "org_a", name: "Ws01" }])
    expect(JSON.stringify(listing)).not.toContain(TOKEN)
  })

  it("provider.resolve returns the token under its own env var plus the org's provider block", async () => {
    const f = track(await makeDb())
    const provider = { "opencode-go": { options: { headers: { "x-opencode-org-id": "org_b" } } } }
    const fetchMock = vi.fn(async () => jsonResponse({ config: { provider } }))
    const out = await createOpencodeSubaccountProvider({
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    }).resolve(
      {
        id: "opencode-ws02",
        endpoint: "opencode-go",
        method: "api-key",
        source: "opencode-console",
        subaccount: { kind: "org", id: "org_b" },
      },
      {},
    )
    expect(out.credential).toBe(TOKEN)
    expect(out.credentialEnvOverride).toBe("OPENCODE_CONSOLE_TOKEN")
    expect(JSON.parse(out.env!.OPENCODE_CONFIG_CONTENT!)).toEqual({ provider })
    expect(JSON.stringify(out.env)).not.toContain(TOKEN)
  })

  it("(a) two accounts, active does not hold the org, the other does: resolves with the second account's token", async () => {
    const f = track(await makeDb({ accounts: 2, activeId: "acc_1" }))
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      const auth = (init?.headers as Record<string, string>)?.authorization
      if (u.endsWith("/api/orgs")) {
        if (auth === `Bearer ${TOKEN}`) {
          return jsonResponse([{ id: "org_a" }])
        }
        if (auth === "Bearer st_OTHER_2") {
          return jsonResponse([{ id: "org_b" }])
        }
        return jsonResponse([])
      }
      if (u.endsWith("/api/config")) {
        if (auth === "Bearer st_OTHER_2") {
          return jsonResponse({ config: { provider: { "opencode-go": { options: { headers: { "x-opencode-org-id": "org_b" } } } } } })
        }
        return jsonResponse({ error: "forbidden" }, 403)
      }
      return jsonResponse({}, 404)
    })
    const out = await resolveOpencodeConsoleOrg("org_b", "opencode-ws02", {
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    })
    expect(out.credential).toBe("st_OTHER_2")
    expect(JSON.stringify(out.extraEnv)).not.toContain(TOKEN)
  })

  it("(b) active account holds the org: only one /api/orgs call is made", async () => {
    const f = track(await makeDb({ accounts: 2, activeId: "acc_1" }))
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      const auth = (init?.headers as Record<string, string>)?.authorization
      if (u.endsWith("/api/orgs")) {
        if (auth === `Bearer ${TOKEN}`) {
          return jsonResponse([{ id: "org_a" }])
        }
        return jsonResponse([])
      }
      if (u.endsWith("/api/config")) {
        return jsonResponse({ config: { provider: { "opencode-go": {} } } })
      }
      return jsonResponse({}, 404)
    })
    const out = await resolveOpencodeConsoleOrg("org_a", "opencode-ws01", {
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    })
    expect(out.credential).toBe(TOKEN)
    const orgsCalls = fetchMock.mock.calls.filter(c => String(c[0]).endsWith("/api/orgs"))
    expect(orgsCalls.length).toBe(1)
  })

  it("(c) org in no account: error names both accounts and contains no token", async () => {
    const f = track(await makeDb({ accounts: 2, activeId: "acc_1" }))
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith("/api/orgs")) {
        return jsonResponse([{ id: "org_a" }])
      }
      return jsonResponse({}, 404)
    })
    const err = (await resolveOpencodeConsoleOrg("org_z", "opencode-ws09", {
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e as Error)) as Error
    expect(err).toBeInstanceOf(SubaccountError)
    expect(err.message).toMatch(/acc_1|user1@example\.test/)
    expect(err.message).toMatch(/acc_2|user2@example\.test/)
    expect(err.message).not.toContain(TOKEN)
    expect(err.message).not.toContain("st_OTHER_2")
  })

  it("(d) one account expired, the other holds the org: resolves", async () => {
    const f = track(await makeDb({ accounts: 2, activeId: "acc_1", expiry: NOW - 1000 }))
    // Make acc_1 expired, acc_2 not expired
    const specifier = ["node", "sqlite"].join(":")
    const { DatabaseSync } = (await import(specifier)) as typeof import("node:sqlite")
    const db = new DatabaseSync(f.dbPath)
    db.prepare("UPDATE account SET token_expiry = ? WHERE id = ?").run(NOW + 3_600_000, "acc_2")
    db.close()
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      const auth = (init?.headers as Record<string, string>)?.authorization
      if (u.endsWith("/api/orgs")) {
        if (auth === "Bearer st_OTHER_2") return jsonResponse([{ id: "org_b" }])
        return jsonResponse([])
      }
      if (u.endsWith("/api/config")) {
        return jsonResponse({ config: { provider: { "opencode-go": {} } } })
      }
      return jsonResponse({}, 404)
    })
    const out = await resolveOpencodeConsoleOrg("org_b", "opencode-ws03", {
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    })
    expect(out.credential).toBe("st_OTHER_2")
  })

  it("(f) /api/orgs fails for the first account: the next account is still tried", async () => {
    const f = track(await makeDb({ accounts: 2, activeId: "acc_1" }))
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      const auth = (init?.headers as Record<string, string>)?.authorization
      if (u.endsWith("/api/orgs")) {
        return auth === `Bearer ${TOKEN}` ? jsonResponse({ error: "boom" }, 500) : jsonResponse([{ id: "org_b" }])
      }
      return jsonResponse({ config: { provider: { "opencode-go": {} } } })
    })
    const out = await resolveOpencodeConsoleOrg("org_b", "opencode-ws02", {
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    })
    expect(out.credential).toBe("st_OTHER_2")
  })

  it("(g) /api/orgs fails on every account: the error lists them and holds no token", async () => {
    const f = track(await makeDb({ accounts: 2, activeId: "acc_1" }))
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, 500))
    const err = (await resolveOpencodeConsoleOrg("org_b", "opencode-ws02", {
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e as Error)) as Error
    expect(err).toBeInstanceOf(SubaccountError)
    expect(err.message).toMatch(/org list failed/)
    expect(err.message).toMatch(/user1@example\.test/)
    expect(err.message).toMatch(/user2@example\.test/)
    expect(err.message).not.toContain(TOKEN)
    expect(err.message).not.toContain("st_OTHER_2")
  })

  it("(h) a single expired account keeps the explicit expired-session message", async () => {
    const f = track(await makeDb({ expiry: NOW - 1000 }))
    await expect(
      resolveOpencodeConsoleOrg("org_a", "opencode-ws01", { dbPath: f.dbPath, now: () => NOW, fetch: vi.fn() }),
    ).rejects.toThrow(/session for user1@example\.test expired at/)
  })

  it("(i) provider.list also lists the orgs of the non-active logins, skipping one that fails", async () => {
    const f = track(await makeDb({ accounts: 3, activeId: "acc_1" }))
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.authorization
      if (auth === `Bearer ${TOKEN}`) return jsonResponse([{ id: "org_a", name: "Ws01" }])
      if (auth === "Bearer st_OTHER_2") return jsonResponse([{ id: "org_a", name: "dup" }, { id: "org_b", name: "Ws02" }])
      return jsonResponse({ error: "boom" }, 500)
    })
    const listing = await createOpencodeSubaccountProvider({
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    }).list({ endpoint: "opencode-go", source: "opencode-console" })
    expect(listing.account).toEqual({ id: "acc_1", label: "user1@example.test" })
    expect(listing.subaccounts).toEqual([
      { kind: "org", id: "org_a", name: "Ws01" },
      { kind: "org", id: "org_b", name: "Ws02" },
    ])
  })

  it("(j) provider.list skips a non-active expired login without fetching it", async () => {
    const f = track(await makeDb({ accounts: 2, activeId: "acc_1" }))
    const specifier = ["node", "sqlite"].join(":")
    const { DatabaseSync } = (await import(specifier)) as typeof import("node:sqlite")
    const db = new DatabaseSync(f.dbPath)
    db.prepare("UPDATE account SET token_expiry = ? WHERE id = 'acc_2'").run(NOW - 1000)
    db.close()
    const fetchMock = vi.fn(async () => jsonResponse([{ id: "org_a", name: "Ws01" }]))
    const listing = await createOpencodeSubaccountProvider({
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    }).list({ endpoint: "opencode-go", source: "opencode-console" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(listing.subaccounts).toEqual([{ kind: "org", id: "org_a", name: "Ws01" }])
  })

  it("(k) provider.list still returns the active login's orgs when every other login fails", async () => {
    const f = track(await makeDb({ accounts: 3, activeId: "acc_1" }))
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.authorization
      if (auth === `Bearer ${TOKEN}`) return jsonResponse([{ id: "org_a", name: "Ws01" }])
      return jsonResponse({ error: "boom" }, 500)
    })
    const listing = await createOpencodeSubaccountProvider({
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    }).list({ endpoint: "opencode-go", source: "opencode-console" })
    expect(listing.account).toEqual({ id: "acc_1", label: "user1@example.test" })
    expect(listing.subaccounts).toEqual([{ kind: "org", id: "org_a", name: "Ws01" }])
  })

  it("(e) single-account behaviour unchanged", async () => {
    const f = track(await makeDb({ accounts: 1 }))
    const provider = { "opencode-go": {} }
    const fetchMock = vi.fn(async () => jsonResponse({ config: { provider } }))
    const out = await resolveOpencodeConsoleOrg("org_a", "opencode-ws01", {
      dbPath: f.dbPath,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
    })
    expect(out.credential).toBe(TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String((fetchMock.mock.calls as unknown[][])[0]![0])).toContain("/api/config")
  })
  describe("per-account ownership (the owning login, never the active one)", () => {
    const CONFIG = { config: { provider: { "opencode-go": {} } } }
    const setExpiry = async (dbPath: string, id: string, expiry: number) => {
      const specifier = ["node", "sqlite"].join(":")
      const { DatabaseSync } = (await import(specifier)) as typeof import("node:sqlite")
      const db = new DatabaseSync(dbPath)
      db.prepare("UPDATE account SET token_expiry = ? WHERE id = ?").run(expiry, id)
      db.close()
    }
    /** acc_1 owns org_a, acc_2 owns org_b; /api/config 403s unless the bearer owns the org. */
    const consoleFetch = () =>
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url)
        const h = init?.headers as Record<string, string>
        const owns: Record<string, string> = { [`Bearer ${TOKEN}`]: "org_a", "Bearer st_OTHER_2": "org_b" }
        if (u.endsWith("/api/orgs")) return jsonResponse(owns[h.authorization!] ? [{ id: owns[h.authorization!] }] : [], 200)
        if (u.endsWith("/api/config")) {
          return owns[h.authorization!] === h["x-org-id"] ? jsonResponse(CONFIG) : jsonResponse({ error: "forbidden" }, 403)
        }
        return jsonResponse({}, 404)
      })
    const run = (orgId: string, profile: string, f: Fixture, fetchMock: ReturnType<typeof consoleFetch>) =>
      resolveOpencodeConsoleOrg(orgId, profile, {
        dbPath: f.dbPath,
        now: () => NOW,
        fetch: fetchMock as unknown as typeof fetch,
      })

    it("active = the other login: the profile still gets the token of the login that owns its org", async () => {
      const f = track(await makeDb({ accounts: 2, activeId: "acc_2" }))
      const fetchMock = consoleFetch()
      expect((await run("org_a", "opencode-ws01", f, fetchMock)).credential).toBe(TOKEN)
      expect((await run("org_b", "opencode-ws-b", f, fetchMock)).credential).toBe("st_OTHER_2")
    })

    it("owner expired, other login (active) still valid: names the owner by email and expiry, not a bare 403", async () => {
      const f = track(await makeDb({ accounts: 2, activeId: "acc_2" }))
      const fetchMock = consoleFetch()
      // the daemon saw acc_1 while its session was still valid ...
      await run("org_a", "opencode-ws01", f, fetchMock)
      await setExpiry(f.dbPath, "acc_1", NOW - 1000)
      fetchMock.mockClear()
      const err = (await run("org_a", "opencode-ws01", f, fetchMock).catch((e: unknown) => e)) as OpencodeAccountExpiredError
      expect(err).toBeInstanceOf(OpencodeAccountExpiredError)
      expect(err).toBeInstanceOf(SubaccountError)
      expect(err.name).toBe("SubaccountError")
      expect(err.profileId).toBe("opencode-ws01")
      expect(err.orgId).toBe("org_a")
      expect(err.accounts).toEqual([{ id: "acc_1", email: "user1@example.test", expiresAt: NOW - 1000 }])
      expect(err.message).toContain("user1@example.test")
      expect(err.message).toContain(new Date(NOW - 1000).toISOString())
      expect(err.message).not.toMatch(/403/)
      expect(err.message).not.toContain(TOKEN)
      expect(err.message).not.toContain("st_OTHER_2")
      // the valid login's token is never sent to /api/config for an org it does not own
      expect(fetchMock.mock.calls.some(c => String(c[0]).endsWith("/api/config"))).toBe(false)
    })

    it("owner expired and never seen valid: reports the expired login as the likely owner, not a bare 403", async () => {
      const f = track(await makeDb({ accounts: 2, activeId: "acc_2" }))
      await setExpiry(f.dbPath, "acc_1", NOW - 1000)
      const err = (await run("org_a", "opencode-ws01", f, consoleFetch()).catch((e: unknown) => e)) as Error
      expect(err).toBeInstanceOf(OpencodeAccountExpiredError)
      expect(err.message).toContain("user1@example.test")
      expect(err.message).toContain(new Date(NOW - 1000).toISOString())
      expect(err.message).not.toMatch(/403/)
    })

    it("no login owns the sub-account: typed error names profile, sub-account and the parent emails tried", async () => {
      const f = track(await makeDb({ accounts: 2, activeId: "acc_2" }))
      const err = (await run("org_z", "opencode-ws09", f, consoleFetch()).catch((e: unknown) => e)) as OpencodeOrgOwnerNotFoundError
      expect(err).toBeInstanceOf(OpencodeOrgOwnerNotFoundError)
      expect(err).toBeInstanceOf(SubaccountError)
      expect(err.profileId).toBe("opencode-ws09")
      expect(err.orgId).toBe("org_z")
      expect(err.tried).toEqual(["user1@example.test", "user2@example.test"])
      expect(err.message).toMatch(/opencode-ws09/)
      expect(err.message).toMatch(/org_z/)
      expect(err.message).toMatch(/user1@example\.test.*user2@example\.test/)
      expect(err.message).toMatch(/log in/i)
      expect(err.message).not.toContain(TOKEN)
      expect(err.message).not.toContain("st_OTHER_2")
    })

    it("caches each login's org list: a second resolve does not call /api/orgs again", async () => {
      const f = track(await makeDb({ accounts: 2, activeId: "acc_2" }))
      const fetchMock = consoleFetch()
      await run("org_a", "opencode-ws01", f, fetchMock)
      await run("org_a", "opencode-ws01", f, fetchMock)
      await run("org_b", "opencode-ws-b", f, fetchMock)
      const orgsCalls = fetchMock.mock.calls.filter(c => String(c[0]).endsWith("/api/orgs"))
      expect(orgsCalls.length).toBe(2)
    })

    it("a cached 'not owned' answer is re-checked once before failing with no owner", async () => {
      const f = track(await makeDb({ accounts: 2, activeId: "acc_2" }))
      let acc1Orgs = [{ id: "org_a" }]
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const h = init?.headers as Record<string, string>
        if (String(url).endsWith("/api/orgs")) {
          return jsonResponse(h.authorization === `Bearer ${TOKEN}` ? acc1Orgs : [{ id: "org_b" }])
        }
        return jsonResponse(CONFIG)
      })
      const call = (org: string) =>
        resolveOpencodeConsoleOrg(org, "opencode-new", {
          dbPath: f.dbPath,
          now: () => NOW,
          fetch: fetchMock as unknown as typeof fetch,
        })
      await expect(call("org_new")).rejects.toBeInstanceOf(OpencodeOrgOwnerNotFoundError)
      acc1Orgs = [{ id: "org_a" }, { id: "org_new" }]
      expect((await call("org_new")).credential).toBe(TOKEN)
    })

    it("never writes account_state while picking the owner", async () => {
      const f = track(await makeDb({ accounts: 2, activeId: "acc_2" }))
      await run("org_a", "opencode-ws01", f, consoleFetch())
      const specifier = ["node", "sqlite"].join(":")
      const { DatabaseSync } = (await import(specifier)) as typeof import("node:sqlite")
      const db = new DatabaseSync(f.dbPath, { readOnly: true })
      expect(db.prepare("SELECT active_account_id FROM account_state").get()).toEqual({ active_account_id: "acc_2" })
      db.close()
    })
  })
})

describe("opencode console: a login that needs redoing names the command that fixes it", () => {
  const dirs: string[] = []
  const track = (f: Fixture) => {
    dirs.push(f.dir)
    return f
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const deps = (f: Fixture, fetchImpl: unknown = vi.fn()) => ({
    dbPath: f.dbPath,
    now: () => NOW,
    fetch: fetchImpl as typeof fetch,
  })

  it("an expired parent session: the message and details.reauth carry `agentproto auth reauth <profile>`", async () => {
    const f = track(await makeDb({ expiry: NOW - 1000 }))
    const err = (await resolveOpencodeConsoleOrg("org_a", "opencode-ws01", deps(f)).catch((e: unknown) => e)) as Error
    expect(err.message).toContain("`agentproto auth reauth opencode-ws01`")
    expect(err.message).toMatch(/one re-login of the parent account fixes every sub-account/)
    expect(err.message).not.toMatch(/\b403\b/)
    expect(reauthHintOf(err)).toMatchObject({
      command: "agentproto auth reauth opencode-ws01",
      profile: "opencode-ws01",
      source: "opencode-console",
      reason: "expired",
      parent: { id: "acc_1", label: "user1@example.test", expiredAt: NOW - 1000 },
    })
    expect(JSON.stringify(reauthHintOf(err))).not.toContain(TOKEN)
  })

  it("no stored login at all: reason missing, still the command", async () => {
    const f = track(await makeDb({ accounts: 0 }))
    const err = (await readOpencodeConsoleAccount(deps(f)).catch((e: unknown) => e)) as Error
    expect(reauthHintOf(err)).toMatchObject({ command: "agentproto auth reauth opencode-console", reason: "missing" })
    expect(err.message).toContain("agentproto auth reauth opencode-console")
  })

  it("no opencode.db: reason missing and the command", async () => {
    const f = track(await makeDb())
    const err = (await readOpencodeConsoleAccount({ ...deps(f), dbPath: join(f.dir, "absent.db") }).catch(
      (e: unknown) => e,
    )) as Error
    expect(reauthHintOf(err)).toMatchObject({ reason: "missing" })
    expect(err.message).toContain("agentproto auth reauth opencode-console")
  })

  it("no login owns the sub-account: the typed error carries the profile's reauth command", async () => {
    const f = track(await makeDb({ accounts: 2, activeId: "acc_2" }))
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/api/orgs") ? jsonResponse([{ id: "org_other" }]) : jsonResponse({}, 404),
    )
    const err = (await resolveOpencodeConsoleOrg("org_z", "opencode-ws09", deps(f, fetchMock)).catch(
      (e: unknown) => e,
    )) as OpencodeOrgOwnerNotFoundError
    expect(err).toBeInstanceOf(OpencodeOrgOwnerNotFoundError)
    expect(reauthHintOf(err)).toMatchObject({
      command: "agentproto auth reauth opencode-ws09",
      reason: "missing",
      profile: "opencode-ws09",
    })
    expect(err.message).toContain("agentproto auth reauth opencode-ws09")
  })

  it("the console rejects the stored session (401/403 on the config fetch): rejected, not a bare 403", async () => {
    const f = track(await makeDb())
    const fetchMock = vi.fn(async () => jsonResponse({ error: "forbidden" }, 403))
    const err = (await resolveOpencodeConsoleOrg("org_a", "opencode-ws01", deps(f, fetchMock)).catch(
      (e: unknown) => e,
    )) as Error
    expect(reauthHintOf(err)).toMatchObject({ command: "agentproto auth reauth opencode-ws01", reason: "rejected" })
    expect(err.message).toContain("`agentproto auth reauth opencode-ws01`")
    expect(err.message).not.toContain(TOKEN)
  })

  it("every login is refused by /api/orgs: rejected with the command", async () => {
    const f = track(await makeDb({ accounts: 2, activeId: "acc_1" }))
    const fetchMock = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401))
    const err = (await resolveOpencodeConsoleOrg("org_b", "opencode-ws02", deps(f, fetchMock)).catch(
      (e: unknown) => e,
    )) as Error
    expect(reauthHintOf(err)).toMatchObject({ command: "agentproto auth reauth opencode-ws02", reason: "rejected" })
  })

  it("a failure a re-login cannot fix carries no reauth hint (network down)", async () => {
    const f = track(await makeDb({ accounts: 2, activeId: "acc_1" }))
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, 500))
    const err = (await resolveOpencodeConsoleOrg("org_b", "opencode-ws02", deps(f, fetchMock)).catch(
      (e: unknown) => e,
    )) as Error
    expect(err).toBeInstanceOf(SubaccountError)
    expect(reauthHintOf(err)).toBeUndefined()
  })
})

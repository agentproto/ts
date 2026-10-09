import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  listOpencodeConsoleOrgs,
  opencodeConsoleSource,
  parseOpencodeConsoleSource,
  readOpencodeConsoleAccount,
  resolveOpencodeConsoleOrg,
} from "../opencode-console-source.js"
import { resolveAuthSpec, SubscriptionSourceError, type AdapterAuthDescriptor } from "../spawn-defaults.js"

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

describe("opencode console source", () => {
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

  it("encodes and parses the profile source", () => {
    expect(opencodeConsoleSource("org_01ABC")).toBe("opencode-console:org_01ABC")
    expect(parseOpencodeConsoleSource("opencode-console:org_01ABC")).toEqual({ orgId: "org_01ABC" })
    expect(parseOpencodeConsoleSource("opencode-console:")).toBeUndefined()
    expect(parseOpencodeConsoleSource("claude-code-oauth")).toBeUndefined()
    expect(parseOpencodeConsoleSource(undefined)).toBeUndefined()
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
      SubscriptionSourceError,
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
    expect(err).toBeInstanceOf(SubscriptionSourceError)
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
})

describe("resolveAuthSpec with an opencode console org", () => {
  const descriptor: AdapterAuthDescriptor = { authEnforce: "always" }
  it("injects the bearer under OPENCODE_CONSOLE_TOKEN, scrubs the key env, carries extraEnv and the echo source", () => {
    const result = resolveAuthSpec({
      descriptor,
      requestedProvider: "opencode-go" as never,
      requestedMode: "api-key",
      explicit: true,
      apiKeyConfigCredential: TOKEN,
      credentialEnvOverride: "OPENCODE_CONSOLE_TOKEN",
      apiKeyCredentialSource: "opencode-console",
      extraEnv: { OPENCODE_CONFIG_CONTENT: "{}" },
    })
    expect(result).toBeDefined()
    const { spec, echo } = result!
    expect(spec.setEnv).toBe("OPENCODE_CONSOLE_TOKEN")
    expect(spec.credential).toBe(TOKEN)
    expect(spec.extraEnv).toEqual({ OPENCODE_CONFIG_CONTENT: "{}" })
    expect(spec.unsetEnv).toContain("OPENCODE_API_KEY")
    expect(echo.credentialSource).toBe("opencode-console")
    expect(echo.fingerprint).not.toContain(TOKEN)
  })

  it("a plain api-key profile still sets the provider's own key env and carries no extraEnv", () => {
    const { spec } = resolveAuthSpec({
      descriptor,
      requestedProvider: "opencode-go" as never,
      requestedMode: "api-key",
      explicit: true,
      apiKeyConfigCredential: "k-plain",
    })!
    expect(spec.setEnv).toBe("OPENCODE_API_KEY")
    expect(spec.credential).toBe("k-plain")
    expect(spec.extraEnv).toBeUndefined()
  })
})

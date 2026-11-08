import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { profileAuthStatus, registerReauthAdapter, unregisterReauthAdapter, type AuthProfile } from "@agentproto/auth"
import { createOpencodeReauthAdapter } from "./reauth.js"

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

interface Login {
  id: string
  email: string
  token: string
  expiry: number
}

const A: Login = { id: "acc_1", email: "user1@example.test", token: "st_FAKE_A_0001", expiry: NOW + 48 * HOUR }
const B: Login = { id: "acc_2", email: "user2@example.test", token: "st_FAKE_B_0001", expiry: NOW + 48 * HOUR }

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function open(path: string, readOnly = false) {
  const specifier = ["node", "sqlite"].join(":")
  const { DatabaseSync } = (await import(specifier)) as typeof import("node:sqlite")
  return new DatabaseSync(path, { readOnly })
}

async function makeDb(logins: Login[], activeId: string | null): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "oc-reauth-"))
  dirs.push(dir)
  const dbPath = join(dir, "opencode.db")
  const db = await open(dbPath)
  db.exec(`CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL, url text NOT NULL,
    access_token text NOT NULL, refresh_token text NOT NULL, token_expiry integer,
    time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE account_state (id integer PRIMARY KEY NOT NULL, active_account_id text, active_org_id text);`)
  for (const l of logins) putLogin(db, l)
  db.prepare("INSERT INTO account_state VALUES (1, ?, ?)").run(activeId, "org_active")
  db.close()
  return dbPath
}

function putLogin(db: Awaited<ReturnType<typeof open>>, l: Login) {
  db.prepare("INSERT OR REPLACE INTO account VALUES (?,?,?,?,?,?,?,?)").run(
    l.id,
    l.email,
    "https://console.example.test/console/",
    l.token,
    `rt_${l.token}`,
    l.expiry,
    1,
    1,
  )
}

/** What `opencode console login` does to the db: replaces/adds sessions, may move the active account. */
async function simulateLogin(dbPath: string, logins: Login[], activeId?: string) {
  const db = await open(dbPath)
  for (const l of logins) putLogin(db, l)
  if (activeId !== undefined) db.prepare("UPDATE account_state SET active_account_id = ?").run(activeId)
  db.close()
}

/** Each bearer owns exactly the orgs listed for it; /api/config 403s for anything else. */
function consoleFetch(owns: Record<string, string[]>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const h = init?.headers as Record<string, string>
    const orgs = owns[h.authorization!.replace("Bearer ", "")] ?? []
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } })
    if (String(url).endsWith("/api/orgs")) return json(orgs.map(id => ({ id })))
    if (String(url).endsWith("/api/config")) {
      return orgs.includes(h["x-org-id"]!) ? json({ config: { provider: { "opencode-go": {} } } }) : json({ error: "forbidden" }, 403)
    }
    return json({}, 404)
  })
}

const profileFor = (orgId: string, id = "opencode-ws01"): AuthProfile => ({
  id,
  endpoint: "opencode-go",
  method: "api-key",
  source: "opencode-console",
  subaccount: { kind: "org", id: orgId },
})

const adapterFor = (dbPath: string, fetchImpl: ReturnType<typeof consoleFetch> = consoleFetch({})) =>
  createOpencodeReauthAdapter({ dbPath, now: () => NOW, fetch: fetchImpl as unknown as typeof fetch })

describe("opencode console reauth adapter", () => {
  it("runs `opencode console login` for the parent account", () => {
    const plan = adapterFor("unused").plan({ source: "opencode-console" }, { loggedIn: true })
    expect(plan).toMatchObject({ kind: "command", command: "opencode", args: ["console", "login"] })
  })

  it("inspects the PARENT that owns a sub-account profile, not the active account", async () => {
    const dbPath = await makeDb([A, B], B.id)
    const fetchMock = consoleFetch({ [A.token]: ["org_a"], [B.token]: ["org_b"] })
    const info = await adapterFor(dbPath, fetchMock).inspect({ source: "opencode-console", profile: profileFor("org_a") })
    expect(info).toMatchObject({
      id: A.id,
      label: A.email,
      loggedIn: true,
      expiresAtMs: A.expiry,
      activeAccountId: B.id,
    })
    expect(info.logins).toHaveLength(2)
    expect(JSON.stringify(info)).not.toContain(A.token)
    expect(JSON.stringify(info)).not.toContain(B.token)
  })

  it("reports an expired owner as logged in with its past expiry", async () => {
    const dbPath = await makeDb([{ ...A, expiry: NOW - HOUR }, B], B.id)
    const fetchMock = consoleFetch({ [A.token]: ["org_a"], [B.token]: ["org_b"] })
    // the daemon saw the owner while it was valid: the expired login is the known owner
    const live = adapterFor(await makeDb([A, B], B.id), fetchMock)
    await live.inspect({ source: "opencode-console", profile: profileFor("org_a") })
    const info = await adapterFor(dbPath, fetchMock).inspect({ source: "opencode-console", profile: profileFor("org_a") })
    expect(info.loggedIn).toBe(true)
    expect(info.expiresAtMs).toBe(A.expiry - 49 * HOUR)
  })

  it("no opencode.db: not logged in, with the reason", async () => {
    const info = await adapterFor(join(tmpdir(), "definitely-absent-oc.db")).inspect({ source: "opencode-console" })
    expect(info.loggedIn).toBe(false)
    expect(info.note).toBeTruthy()
  })

  it("feeds expiresAt and state into profileAuthStatus for a sub-account profile", async () => {
    const dbPath = await makeDb([{ ...A, expiry: NOW + 2 * HOUR }, B], B.id)
    const fetchMock = consoleFetch({ [A.token]: ["org_a"], [B.token]: ["org_b"] })
    registerReauthAdapter(adapterFor(dbPath, fetchMock))
    try {
      const st = await profileAuthStatus(profileFor("org_a"), { now: NOW })
      expect(st.state).toBe("expiring")
      expect(st.expiresAt).toBe(new Date(A.expiry - 46 * HOUR).toISOString())
      expect(st.parent).toEqual({ source: "opencode-console", id: A.id, label: A.email, loggedIn: true })
      expect(JSON.stringify(st)).not.toContain(A.token)
      const other = await profileAuthStatus(profileFor("org_b", "opencode-ws02"), { now: NOW })
      expect(other.state).toBe("ok")
      expect(other.parent?.id).toBe(B.id)
    } finally {
      unregisterReauthAdapter("opencode-console")
    }
  })

  describe("verify", () => {
    const target = { source: "opencode-console", profile: profileFor("org_a") }

    it("verified: the owner's session was replaced, the other login and the active account untouched", async () => {
      const dbPath = await makeDb([{ ...A, expiry: NOW - HOUR }, B], B.id)
      const before = await adapterFor(dbPath).inspect({ source: "opencode-console" }) // by active account
      const seen = adapterFor(dbPath, consoleFetch({ [A.token]: ["org_a"], [B.token]: ["org_b"] }))
      const beforeOwner = await seen.inspect(target)
      await simulateLogin(dbPath, [{ ...A, token: "st_FAKE_A_0002", expiry: NOW + 48 * HOUR }])
      const after = adapterFor(dbPath, consoleFetch({ st_FAKE_A_0002: ["org_a"], [B.token]: ["org_b"] }))
      const v = await after.verify(target, beforeOwner)
      expect(before.id).toBe(B.id)
      expect(v.status).toBe("verified")
      expect(v.problems).toEqual([])
      expect(v.checked.join("\n")).toMatch(/owns sub-account org_a/)
      expect(v.checked.join("\n")).toMatch(/same parent account as before/)
      expect(v.checked.join("\n")).toMatch(/other stored logins are unchanged/)
      expect(v.checked.join("\n")).toMatch(/active console account was not changed/)
      expect(v.sideEffects).toEqual([])
      expect(JSON.stringify(v)).not.toContain("st_FAKE_A_0002")
    })

    it("fails when nothing changed in the db (the login did not complete)", async () => {
      const dbPath = await makeDb([{ ...A, expiry: NOW + 2 * HOUR }, B], B.id)
      const adapter = adapterFor(dbPath, consoleFetch({ [A.token]: ["org_a"], [B.token]: ["org_b"] }))
      const before = await adapter.inspect(target)
      const v = await adapter.verify(target, before)
      expect(v.status).toBe("failed")
      expect(v.problems.join("\n")).toMatch(/no stored session changed/)
    })

    it("fails when the new session is still not accepted for the sub-account", async () => {
      const dbPath = await makeDb([A, B], B.id)
      const before = await adapterFor(dbPath, consoleFetch({ [A.token]: ["org_a"] })).inspect(target)
      await simulateLogin(dbPath, [{ ...A, token: "st_FAKE_A_0002" }])
      const v = await adapterFor(dbPath, consoleFetch({ st_FAKE_A_0002: [], [B.token]: ["org_b"] })).verify(target, before)
      expect(v.status).toBe("failed")
      expect(v.problems.length).toBeGreaterThan(0)
    })

    it("reports a moved active account as a side effect, without undoing it", async () => {
      const dbPath = await makeDb([{ ...A, expiry: NOW - HOUR }, B], B.id)
      const before = await adapterFor(dbPath, consoleFetch({ [A.token]: ["org_a"], [B.token]: ["org_b"] })).inspect(target)
      await simulateLogin(dbPath, [{ ...A, token: "st_FAKE_A_0002", expiry: NOW + 48 * HOUR }], A.id)
      const v = await adapterFor(dbPath, consoleFetch({ st_FAKE_A_0002: ["org_a"], [B.token]: ["org_b"] })).verify(target, before)
      expect(v.status).toBe("verified")
      expect(v.sideEffects).toHaveLength(1)
      expect(v.sideEffects[0]).toContain(`from ${B.email} to ${A.email}`)
      expect(v.sideEffects[0]).toMatch(/agentproto does not depend on it/)
      const db = await open(dbPath, true)
      expect(db.prepare("SELECT active_account_id FROM account_state").get()).toEqual({ active_account_id: A.id })
      db.close()
    })

    it("flags another login that the sign-in replaced", async () => {
      const dbPath = await makeDb([{ ...A, expiry: NOW - HOUR }, B], B.id)
      const before = await adapterFor(dbPath, consoleFetch({ [A.token]: ["org_a"], [B.token]: ["org_b"] })).inspect(target)
      await simulateLogin(dbPath, [
        { ...A, token: "st_FAKE_A_0002", expiry: NOW + 48 * HOUR },
        { ...B, token: "st_FAKE_B_0002" },
      ])
      const v = await adapterFor(dbPath, consoleFetch({ st_FAKE_A_0002: ["org_a"], st_FAKE_B_0002: ["org_b"] })).verify(target, before)
      expect(v.sideEffects.join("\n")).toMatch(/1 other stored login\(s\) were replaced/)
    })

    it("is honest when there was no earlier login to compare with", async () => {
      const dbPath = await makeDb([], null)
      const adapter = adapterFor(dbPath)
      const before = await adapter.inspect(target)
      expect(before.loggedIn).toBe(false)
      await simulateLogin(dbPath, [A], A.id)
      const v = await adapterFor(dbPath, consoleFetch({ [A.token]: ["org_a"] })).verify(target, before)
      expect(v.status).toBe("verified")
      expect(v.notChecked.join("\n")).toMatch(/which account was meant/)
    })
  })
})

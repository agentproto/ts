/**
 * Sub-account provider for opencode console orgs ("workspaces").
 *
 * opencode keeps ONE console login (`account` row + `account_state.active_org_id`
 * in its sqlite db) and, on every start, fetches `<account.url>/api/config`
 * for the active org and merges the returned `provider` block over all other
 * config — env keys and inline config included. So with that login present,
 * every opencode spawn bills the active org, whatever agentproto profile it
 * names. A profile on this source pins ONE org instead: the console session is
 * read (never written) from opencode.db, the pinned org's provider block is
 * fetched with it, and the spawn gets the token + that block through env while
 * the driver runs opencode in a login-less data dir
 * (`AgentCliDefinition.credentialDataHome`) so the stored login can't re-point
 * the providers back.
 *
 * The profile stores only `source: "opencode-console"` + `subaccount: {kind:
 * "org", id}` — no token. The token is read fresh from opencode.db at every
 * spawn. Legacy profiles (`source: "opencode-console:<orgId>"`) are migrated on
 * read. It is NOT refreshed
 * here: the refresh token rotates, and rotating it behind opencode's back would
 * log the operator out of opencode itself. An expired session fails loud.
 */

import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  SubaccountError,
  type SubaccountProvider,
  type SubaccountPin,
} from "@agentproto/auth"

export const OPENCODE_CONSOLE_SOURCE = "opencode-console"
export const OPENCODE_CONSOLE_ORG_KIND = "org"

/** Env var opencode's console provider block reads its bearer from. */
export const OPENCODE_CONSOLE_TOKEN_ENV = "OPENCODE_CONSOLE_TOKEN"

const FETCH_TIMEOUT_MS = 10_000
/** A session expiring inside this window is treated as expired. */
const EXPIRY_SKEW_MS = 60_000

/** Legacy `"opencode-console:<orgId>"` → the org pin it encoded; undefined for any other source. */
export function parseLegacyOpencodeConsoleSource(source: string | undefined): SubaccountPin | undefined {
  if (!source?.startsWith(`${OPENCODE_CONSOLE_SOURCE}:`)) return undefined
  const orgId = source.slice(OPENCODE_CONSOLE_SOURCE.length + 1)
  return orgId.length > 0 ? { kind: OPENCODE_CONSOLE_ORG_KIND, id: orgId } : undefined
}

export function opencodeDbPath(env: Record<string, string | undefined> = process.env): string {
  const dataHome = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "opencode.db")
}

export interface OpencodeConsoleAccount {
  id: string
  email?: string
  /** Console base URL, e.g. `https://opencode.ai/console`. */
  url: string
  accessToken: string
  /** Epoch ms, when opencode recorded one. */
  expiresAt?: number
}

export interface OpencodeConsoleDeps {
  dbPath?: string
  fetch?: typeof fetch
  now?: () => number
}

interface SqliteHandle {
  prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }
  close(): void
}

async function openReadonly(dbPath: string): Promise<SqliteHandle> {
  const specifier = ["node", "sqlite"].join(":")
  const { DatabaseSync } = (await import(/* @vite-ignore */ specifier)) as unknown as {
    DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => SqliteHandle
  }
  return new DatabaseSync(dbPath, { readOnly: true })
}

function loginHint(): string {
  return "Log in once with `opencode auth login` (opencode.ai/console) so its console session is fresh, then retry."
}

interface AccountRow {
  id: string
  email?: string | null
  url: string
  access_token: string
  token_expiry?: number | null
}

function accountFromRow(row: AccountRow, expiresAt?: number): OpencodeConsoleAccount {
  return {
    id: row.id,
    ...(row.email ? { email: row.email } : {}),
    url: row.url.replace(/\/+$/, ""),
    accessToken: row.access_token,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

function isExpired(row: AccountRow, now: number): boolean {
  const expiresAt = typeof row.token_expiry === "number" ? row.token_expiry : undefined
  if (expiresAt !== undefined && expiresAt - now < EXPIRY_SKEW_MS) {
    return true
  }
  return false
}

async function readAllOpencodeConsoleAccounts(
  deps: OpencodeConsoleDeps = {},
): Promise<{ accounts: AccountRow[]; activeId?: string | null }> {
  const dbPath = deps.dbPath ?? opencodeDbPath()
  let db: SqliteHandle | undefined
  try {
    db = await openReadonly(dbPath)
    const active = db.prepare("SELECT active_account_id FROM account_state LIMIT 1").get() as
      | { active_account_id?: string | null }
      | undefined
    const rows = db.prepare("SELECT * FROM account").all() as AccountRow[]
    return { accounts: rows, activeId: active?.active_account_id ?? null }
  } catch (err) {
    throw new SubaccountError(`opencode console login unreadable at ${dbPath} (${err instanceof Error ? err.message : String(err)}). ${loginHint()}`,
    )
  } finally {
    try {
      db?.close()
    } catch {
      // already closed
    }
  }
}

/**
 * Read the logged-in console account from opencode.db, read-only. The active
 * account wins when several are stored. Throws {@link SubaccountError}
 * when there is no login, or when the session is expired.
 */
export async function readOpencodeConsoleAccount(
  deps: OpencodeConsoleDeps = {},
): Promise<OpencodeConsoleAccount> {
  const dbPath = deps.dbPath ?? opencodeDbPath()
  const now = deps.now ?? Date.now
  let row: AccountRow | undefined
  let db: SqliteHandle | undefined
  try {
    db = await openReadonly(dbPath)
    const active = db.prepare("SELECT active_account_id FROM account_state LIMIT 1").get() as
      | { active_account_id?: string | null }
      | undefined
    row = (active?.active_account_id
      ? db.prepare("SELECT * FROM account WHERE id = ?").get(active.active_account_id)
      : db.prepare("SELECT * FROM account LIMIT 1").get()) as AccountRow | undefined
  } catch (err) {
    throw new SubaccountError(`opencode console login unreadable at ${dbPath} (${err instanceof Error ? err.message : String(err)}). ${loginHint()}`,
    )
  } finally {
    try {
      db?.close()
    } catch {
      // already closed
    }
  }
  if (!row || !row.access_token) {
    throw new SubaccountError(`no opencode console account in ${dbPath}. ${loginHint()}`,
    )
  }
  const expiresAt = typeof row.token_expiry === "number" ? row.token_expiry : undefined
  if (expiresAt !== undefined && expiresAt - now() < EXPIRY_SKEW_MS) {
    throw new SubaccountError(`the opencode console session for ${row.email ?? row.id} expired at ${new Date(expiresAt).toISOString()}. ${loginHint()}`,
    )
  }
  return accountFromRow(row, expiresAt)
}

async function consoleGet(
  account: OpencodeConsoleAccount,
  path: string,
  deps: OpencodeConsoleDeps,
  orgId?: string,
): Promise<unknown> {
  const doFetch = deps.fetch ?? fetch
  const res = await doFetch(`${account.url}${path}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${account.accessToken}`,
      ...(orgId ? { "x-org-id": orgId } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return res.json()
}

export interface OpencodeConsoleOrg {
  id: string
  name: string
}

/** Orgs the logged-in console account can use (`GET /api/orgs`). */
export async function listOpencodeConsoleOrgs(
  deps: OpencodeConsoleDeps = {},
): Promise<{ account: OpencodeConsoleAccount; orgs: OpencodeConsoleOrg[] }> {
  const account = await readOpencodeConsoleAccount(deps)
  let body: unknown
  try {
    body = await consoleGet(account, "/api/orgs", deps)
  } catch (err) {
    throw new SubaccountError(`opencode console org listing failed (${err instanceof Error ? err.message : String(err)}). ${loginHint()}`,
    )
  }
  const orgs = (Array.isArray(body) ? body : [])
    .filter((o): o is { id: string; name?: string } => typeof (o as { id?: unknown })?.id === "string")
    .map(o => ({ id: o.id, name: typeof o.name === "string" ? o.name : o.id }))
  return { account, orgs }
}

export interface ResolvedOpencodeConsoleOrg {
  orgId: string
  /** The org-scoped console bearer — goes into {@link OPENCODE_CONSOLE_TOKEN_ENV}. */
  credential: string
  /** Env beside the bearer: the org's `provider` block as inline config. */
  extraEnv: Record<string, string>
}

/**
 * No stored console login owns the pinned sub-account (org). `tried` holds the
 * parent account emails that were checked; the missing piece is a login to the
 * parent account that owns the org. Never carries a token.
 */
export class OpencodeOrgOwnerNotFoundError extends SubaccountError {
  readonly code = "opencode_org_owner_not_found"
  constructor(
    readonly profileId: string,
    readonly orgId: string,
    /** Emails (or ids) of the console logins whose org list was checked. */
    readonly tried: string[],
    /** Logins that could not be checked, with the reason. */
    readonly unchecked: string[] = [],
  ) {
    const triedStr = tried.length > 0 ? tried.join(", ") : "(none)"
    const uncheckedStr = unchecked.length > 0 ? `; could not check: ${unchecked.join(", ")}` : ""
    super(
      `profile "${profileId}": sub-account ${orgId} is not owned by any logged-in opencode console account ` +
        `(parent accounts tried: ${triedStr}${uncheckedStr}). ` +
        `The login of the parent account that owns it is missing: ${loginHint()}`,
    )
  }
}

/**
 * The login that owns (or, with `knownOwner: false`, may own) the pinned
 * sub-account has an expired console session that agentproto does not refresh
 * (refreshing would rotate opencode's own token). Never carries a token.
 */
export class OpencodeAccountExpiredError extends SubaccountError {
  readonly code = "opencode_account_expired"
  constructor(
    readonly profileId: string,
    readonly orgId: string,
    readonly accounts: Array<{ email: string; expiresAt: number }>,
    /** true: this login was seen listing the org; false: it is the only login that could own it. */
    readonly knownOwner: boolean,
  ) {
    const list = accounts.map(a => `${a.email} (expired at ${new Date(a.expiresAt).toISOString()})`).join(", ")
    super(
      knownOwner
        ? `profile "${profileId}": sub-account ${orgId} belongs to the opencode console account ${list}, ` +
            `whose session is expired and is not refreshed here. ${loginHint()}`
        : `profile "${profileId}": sub-account ${orgId} is not owned by any valid opencode console login; ` +
            `the expired session of ${list} may be its parent account (expired sessions are not refreshed here, ` +
            `so its orgs cannot be checked). ${loginHint()}`,
    )
  }
}

const ORG_CACHE_TTL_MS = 5 * 60_000

interface OrgCacheEntry {
  orgIds: Set<string>
  at: number
}

/** Per-login org lists, keyed by db + account id + a hash of the bearer (a new login or a rotated token misses). */
const orgCache = new Map<string, OrgCacheEntry>()
/** Last org list ever seen per db + account id, no TTL: tells an expired login's orgs apart from a stranger's. */
const lastKnownOrgs = new Map<string, Set<string>>()

function orgCacheKey(dbPath: string, row: AccountRow): string {
  const tokenHash = createHash("sha256").update(row.access_token).digest("hex").slice(0, 16)
  return `${dbPath}\0${row.id}\0${tokenHash}`
}

function parseOrgs(body: unknown): OpencodeConsoleOrg[] {
  return (Array.isArray(body) ? body : [])
    .filter((o): o is { id: string; name?: string } => typeof (o as { id?: unknown })?.id === "string")
    .map(o => ({ id: o.id, name: typeof o.name === "string" ? o.name : o.id }))
}

/**
 * Resolve a pinned org to what the spawn needs: the bearer and the org's
 * provider block (which names the org id in its `x-opencode-org-id` header).
 *
 * The token comes from the stored login that OWNS the org (its `/api/orgs`
 * lists it), never from whichever login happens to be active. When several
 * logins are stored, ownership is always proven before `/api/config` is
 * called, so a valid login is never sent to an org it does not own. Fails
 * loud — never falls back to another org or an ambient login — and never
 * writes to opencode.db.
 */
export async function resolveOpencodeConsoleOrg(
  orgId: string,
  profileId: string,
  deps: OpencodeConsoleDeps = {},
): Promise<ResolvedOpencodeConsoleOrg> {
  const dbPath = deps.dbPath ?? opencodeDbPath()
  const now = deps.now ?? Date.now
  const { accounts, activeId } = await readAllOpencodeConsoleAccounts(deps)
  const withToken = accounts.filter(a => a.access_token)
  if (withToken.length === 0) {
    throw new SubaccountError(`no opencode console account in ${dbPath}. ${loginHint()}`)
  }

  const label = (row: AccountRow) => row.email ?? row.id
  const current = now()
  const usableRows = withToken.filter(r => !isExpired(r, current))
  const expiredRows = withToken.filter(r => isExpired(r, current))
  // The active login is only asked first, a tie-break that saves a round trip.
  const askOrder = [...usableRows].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId))
  const expiredInfo = (rows: AccountRow[]) =>
    rows.map(r => ({ email: label(r), expiresAt: r.token_expiry as number }))

  // A lone stored login has nothing to choose between: straight to the config
  // fetch, whose error names the org and the account.
  const single = withToken.length === 1
  if (single && usableRows.length === 0) {
    const r = expiredRows[0]!
    throw new SubaccountError(`the opencode console session for ${label(r)} expired at ${new Date(r.token_expiry as number).toISOString()}. ${loginHint()}`)
  }

  let owner: AccountRow | undefined = single ? usableRows[0] : undefined
  const failed = new Map<string, string>()
  if (!owner) {
    const findOwner = async (fresh: boolean): Promise<{ owner?: AccountRow; usedCache: boolean }> => {
      let usedCache = false
      failed.clear()
      for (const row of askOrder) {
        const key = orgCacheKey(dbPath, row)
        const hit = orgCache.get(key)
        let orgIds: Set<string>
        if (!fresh && hit && now() - hit.at < ORG_CACHE_TTL_MS) {
          orgIds = hit.orgIds
          usedCache = true
        } else {
          try {
            const body = await consoleGet(accountFromRow(row), "/api/orgs", deps)
            orgIds = new Set(parseOrgs(body).map(o => o.id))
          } catch (err) {
            // One broken login must not hide the org held by another one. It is
            // skipped, not tried blind: without its org list there is no proof it
            // holds the org, and /api/config could answer for another one.
            failed.set(label(row), err instanceof Error ? err.message : String(err))
            continue
          }
          orgCache.set(key, { orgIds, at: now() })
          lastKnownOrgs.set(`${dbPath}\0${row.id}`, orgIds)
        }
        if (orgIds.has(orgId)) return { owner: row, usedCache }
      }
      return { usedCache }
    }
    let found = await findOwner(false)
    // A cached "not owned" may predate the operator joining the org: re-check once.
    if (!found.owner && found.usedCache) found = await findOwner(true)
    owner = found.owner
  }

  if (!owner) {
    if (expiredRows.length > 0) {
      const known = expiredRows.filter(r => lastKnownOrgs.get(`${dbPath}\0${r.id}`)?.has(orgId))
      if (known.length > 0) throw new OpencodeAccountExpiredError(profileId, orgId, expiredInfo(known), true)
      // Strangers that never listed the org cannot be ruled out: the expired
      // sessions are the only logins that could own it.
      if (failed.size === 0) throw new OpencodeAccountExpiredError(profileId, orgId, expiredInfo(expiredRows), false)
    }
    if (failed.size > 0 && failed.size === usableRows.length) {
      const failedStr = [...failed].map(([who, why]) => `${who} (${why})`).join(", ")
      throw new SubaccountError(
        `profile "${profileId}": sub-account ${orgId} could not be matched to a console account (org list failed: ${failedStr}). ${loginHint()}`,
      )
    }
    throw new OpencodeOrgOwnerNotFoundError(
      profileId,
      orgId,
      usableRows.map(label),
      [
        ...expiredRows.map(r => `${label(r)} (expired at ${new Date(r.token_expiry as number).toISOString()})`),
        ...[...failed].map(([who, why]) => `${who} (${why})`),
      ],
    )
  }

  const account = accountFromRow(owner, typeof owner.token_expiry === "number" ? owner.token_expiry : undefined)
  let provider: unknown
  try {
    const body = (await consoleGet(account, "/api/config", deps, orgId)) as {
      config?: { provider?: unknown }
    }
    provider = body?.config?.provider
  } catch (err) {
    throw new SubaccountError(`profile "${profileId}": opencode org ${orgId} config fetch failed (${err instanceof Error ? err.message : String(err)}) ` +
        `— the console account ${account.email ?? account.id} may not belong to that org. ${loginHint()}`,
    )
  }
  if (!provider || typeof provider !== "object" || Object.keys(provider).length === 0) {
    throw new SubaccountError(`profile "${profileId}": opencode org ${orgId} returned no provider config.`)
  }
  return {
    orgId,
    credential: account.accessToken,
    extraEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider }) },
  }
}

/**
 * The registry entry. `deps` is injectable for tests (db path, fetch, clock).
 */
export function createOpencodeSubaccountProvider(deps: OpencodeConsoleDeps = {}): SubaccountProvider {
  return {
    id: "opencode-console",
    source: OPENCODE_CONSOLE_SOURCE,
    kinds: [OPENCODE_CONSOLE_ORG_KIND],
    defaultEndpoint: "opencode-go",
    profilePrefix: "opencode",
    migrateLegacySource: parseLegacyOpencodeConsoleSource,
    async list() {
      const { account, orgs } = await listOpencodeConsoleOrgs(deps)
      // The orgs of the other stored logins are listed too, so a pin can be
      // created for them; a login that cannot list is left out, not fatal.
      const seen = new Set(orgs.map(o => o.id))
      const all = [...orgs]
      const current = (deps.now ?? Date.now)()
      const { accounts } = await readAllOpencodeConsoleAccounts(deps)
      // Fetched in parallel (each has its own timeout); merged in stored order.
      const others = accounts.filter(
        row => row.id !== account.id && row.access_token && !isExpired(row, current),
      )
      const bodies = await Promise.all(
        others.map(row =>
          consoleGet(accountFromRow(row), "/api/orgs", deps).catch(() => {
            // skipped: resolve() reports it if a pin needs this login
            return []
          }),
        ),
      )
      for (const body of bodies) {
        for (const o of Array.isArray(body) ? body : []) {
          const id = (o as { id?: unknown })?.id
          if (typeof id !== "string" || seen.has(id)) continue
          seen.add(id)
          const name = (o as { name?: unknown }).name
          all.push({ id, name: typeof name === "string" ? name : id })
        }
      }
      return {
        account: { id: account.id, ...(account.email ? { label: account.email } : {}) },
        subaccounts: all.map(o => ({ kind: OPENCODE_CONSOLE_ORG_KIND, id: o.id, name: o.name })),
      }
    },
    async resolve(profile) {
      const resolved = await resolveOpencodeConsoleOrg(profile.subaccount.id, profile.id, deps)
      return {
        credential: resolved.credential,
        credentialEnvOverride: OPENCODE_CONSOLE_TOKEN_ENV,
        env: resolved.extraEnv,
      }
    },
  }
}

/** The default instance, reading the operator's own opencode.db. */
export const opencodeSubaccounts: SubaccountProvider = createOpencodeSubaccountProvider()

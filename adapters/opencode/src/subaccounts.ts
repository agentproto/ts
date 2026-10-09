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
  prepare(sql: string): { get(...a: unknown[]): unknown }
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
  let row:
    | { id: string; email?: string; url: string; access_token: string; token_expiry?: number | null }
    | undefined
  let db: SqliteHandle | undefined
  try {
    db = await openReadonly(dbPath)
    const active = db.prepare("SELECT active_account_id FROM account_state LIMIT 1").get() as
      | { active_account_id?: string | null }
      | undefined
    row = (active?.active_account_id
      ? db.prepare("SELECT * FROM account WHERE id = ?").get(active.active_account_id)
      : db.prepare("SELECT * FROM account LIMIT 1").get()) as typeof row
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
  return {
    id: row.id,
    ...(row.email ? { email: row.email } : {}),
    url: row.url.replace(/\/+$/, ""),
    accessToken: row.access_token,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
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
 * Resolve a pinned org to what the spawn needs: the bearer and the org's
 * provider block (which names the org id in its `x-opencode-org-id` header).
 * Fails loud — never falls back to another org or an ambient login.
 */
export async function resolveOpencodeConsoleOrg(
  orgId: string,
  profileId: string,
  deps: OpencodeConsoleDeps = {},
): Promise<ResolvedOpencodeConsoleOrg> {
  const account = await readOpencodeConsoleAccount(deps)
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
    throw new SubaccountError(`profile "${profileId}": opencode org ${orgId} returned no provider config.`,
    )
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
      return {
        account: { id: account.id, ...(account.email ? { label: account.email } : {}) },
        subaccounts: orgs.map(o => ({ kind: OPENCODE_CONSOLE_ORG_KIND, id: o.id, name: o.name })),
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

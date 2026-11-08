/**
 * Re-login for the opencode console parent account (`opencode console login`).
 *
 * The console login is a PARENT account that owns the orgs ("workspaces") the
 * profiles pin. Resolution already picks the token of the account that owns
 * the pinned org (see `subaccounts.ts`), so which login is "active" in opencode
 * does not matter to agentproto; a login that moves it is reported, not undone.
 * The login itself stays interactive (browser device flow, run by opencode); this
 * module reads opencode.db before and after, read-only, to say what changed.
 */

import {
  AuthReauthRequiredError,
  deriveAuthState,
  type ParentAccountInfo,
  type ReauthAdapter,
  type ReauthTarget,
  type ReauthVerification,
} from "@agentproto/auth"
import {
  OPENCODE_CONSOLE_SOURCE,
  OpencodeAccountExpiredError,
  readAllOpencodeConsoleAccounts,
  locateOrgOwner,
  resolveOpencodeConsoleOrg,
  sessionFingerprint,
  type AccountRow,
  type OpencodeConsoleDeps,
} from "./subaccounts.js"

const labelOf = (row: AccountRow) => row.email ?? row.id

function expiryOf(row: AccountRow): number | undefined {
  return typeof row.token_expiry === "number" ? row.token_expiry : undefined
}

function loginsOf(rows: AccountRow[]): NonNullable<ParentAccountInfo["logins"]> {
  return rows
    .filter(r => r.access_token)
    .map(r => ({
      id: r.id,
      ...(r.email ? { label: r.email } : {}),
      fingerprint: sessionFingerprint(r),
      ...(expiryOf(r) !== undefined ? { expiresAtMs: expiryOf(r)! } : {}),
    }))
}

function infoFromRow(row: AccountRow, rest: Partial<ParentAccountInfo>): ParentAccountInfo {
  const expiresAtMs = expiryOf(row)
  return {
    id: row.id,
    ...(row.email ? { label: row.email } : {}),
    loggedIn: true,
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    fingerprint: sessionFingerprint(row),
    ...rest,
  }
}

export function createOpencodeReauthAdapter(deps: OpencodeConsoleDeps = {}): ReauthAdapter {
  async function inspect(target: ReauthTarget): Promise<ParentAccountInfo> {
    let read: Awaited<ReturnType<typeof readAllOpencodeConsoleAccounts>>
    try {
      read = await readAllOpencodeConsoleAccounts(deps, target.profile?.id)
    } catch (err) {
      return { loggedIn: false, note: err instanceof Error ? err.message : String(err) }
    }
    const rows = read.accounts.filter(r => r.access_token)
    const shared = {
      ...(read.activeId ? { activeAccountId: read.activeId } : {}),
      logins: loginsOf(rows),
    }
    if (rows.length === 0) return { loggedIn: false, ...shared }

    const pin = target.profile?.subaccount
    if (pin) {
      try {
        return infoFromRow(await locateOrgOwner(pin.id, target.profile!.id, deps), shared)
      } catch (err) {
        if (err instanceof OpencodeAccountExpiredError) {
          const only = err.accounts.length === 1 ? err.accounts[0] : undefined
          const latest = Math.max(...err.accounts.map(a => a.expiresAt))
          return {
            ...(only?.id ? { id: only.id } : {}),
            ...(only ? { label: only.email } : {}),
            loggedIn: true,
            expiresAtMs: latest,
            ...(only?.id
              ? { fingerprint: sessionFingerprint(rows.find(r => r.id === only.id)!) }
              : {}),
            ...(only ? {} : { note: `the owner is one of ${err.accounts.length} expired logins` }),
            ...shared,
          }
        }
        if (err instanceof AuthReauthRequiredError) {
          return {
            loggedIn: err.reauth.reason !== "missing",
            note: err.reauth.reason === "missing" ? "no stored login owns the sub-account" : "the stored session was rejected",
            ...shared,
          }
        }
        return { loggedIn: true, note: err instanceof Error ? err.message : String(err), ...shared }
      }
    }

    // No pin: the profile follows the account opencode itself has active.
    const row = rows.find(r => r.id === read.activeId) ?? rows[0]!
    return infoFromRow(row, shared)
  }

  return {
    source: OPENCODE_CONSOLE_SOURCE,
    aliases: ["opencode", "opencode-go", "opencode-zen"],
    displayName: "OpenCode console",
    scopeNote:
      "The login belongs to the parent account, so this one re-login fixes every sub-account profile under it. " +
      "Since each sub-account profile uses the token of the account that owns it, which account opencode has " +
      "active no longer matters for agentproto, and switching sub-account never needs a re-login.",
    inspect,
    plan() {
      return {
        kind: "command",
        command: "opencode",
        args: ["console", "login"],
        description: "opencode console login (opens a browser; sign in with the parent account)",
      }
    },
    async verify(target, before): Promise<ReauthVerification> {
      const after = await inspect(target)
      const checked: string[] = []
      const notChecked: string[] = []
      const sideEffects: string[] = []
      const problems: string[] = []
      const profile = target.profile
      const pin = profile?.subaccount

      const afterLogins = after.logins ?? []
      const beforeLogins = before.logins ?? []

      // The login replaced a stored session, or added one.
      const replaced =
        after.fingerprint !== undefined &&
        (before.fingerprint === undefined || before.fingerprint !== after.fingerprint)
      const addedOrChanged = afterLogins.some(
        a => !beforeLogins.some(b => b.id === a.id && b.fingerprint === a.fingerprint),
      )

      if (pin && profile) {
        try {
          // Ownership is proven through the org list and the token is exercised
          // against the org's config endpoint; the result is discarded.
          await resolveOpencodeConsoleOrg(pin.id, profile.id, deps)
          checked.push(
            `a stored login owns sub-account ${pin.id} and its session is accepted by the console (${after.label ?? after.id ?? "owner"})`,
          )
        } catch (err) {
          problems.push(err instanceof Error ? err.message : String(err))
        }
        if (before.id !== undefined && after.id !== undefined) {
          if (before.id === after.id) checked.push("the owner is the same parent account as before the login")
          else problems.push("the sub-account is now owned by a different login than before")
        } else {
          notChecked.push(
            "which account was meant: there was no earlier login to compare with, so only ownership of the sub-account was checked",
          )
        }
      } else {
        const expected = before.id
        const target_ = expected !== undefined ? afterLogins.find(l => l.id === expected) : undefined
        if (expected !== undefined && target_ === undefined) {
          problems.push("the expected parent account is no longer stored")
        } else if (target_ !== undefined && deriveAuthState(target_.expiresAtMs, deps.now?.()) === "expired") {
          problems.push(`the session of ${target_.label ?? target_.id} is still expired`)
        } else if (target_ !== undefined) {
          checked.push(`the session of ${target_.label ?? target_.id} is unexpired`)
        } else if (afterLogins.some(l => deriveAuthState(l.expiresAtMs, deps.now?.()) !== "expired")) {
          checked.push("an unexpired console session is stored")
          notChecked.push("which account was meant: no account was named for this target")
        } else {
          problems.push("no unexpired console session is stored")
        }
        notChecked.push("sub-account ownership: this target names none")
      }

      if (!replaced && !addedOrChanged) {
        problems.push("no stored session changed: the login did not complete, or was for an account that is already current")
      } else {
        checked.push("opencode.db holds a new or replaced session")
      }

      const expectedIds = new Set([before.id, after.id].filter((x): x is string => x !== undefined))
      const collateral = beforeLogins.filter(b => {
        const now = afterLogins.find(a => a.id === b.id)
        return now !== undefined && now.fingerprint !== b.fingerprint && !expectedIds.has(b.id)
      })
      const lost = beforeLogins.filter(b => !afterLogins.some(a => a.id === b.id))
      if (collateral.length > 0) {
        sideEffects.push(`${collateral.length} other stored login(s) were replaced by the login`)
      } else if (beforeLogins.length > 0) {
        checked.push("the other stored logins are unchanged")
      }
      if (lost.length > 0) sideEffects.push(`${lost.length} stored login(s) disappeared during the login`)

      const labelFor = (id: string | undefined) =>
        id === undefined ? "none" : (afterLogins.find(l => l.id === id)?.label ?? beforeLogins.find(l => l.id === id)?.label ?? id)
      if (before.activeAccountId !== after.activeAccountId) {
        sideEffects.push(
          `opencode's own active console account changed from ${labelFor(before.activeAccountId)} to ${labelFor(after.activeAccountId)}. ` +
            `agentproto does not depend on it (each sub-account profile uses the token of the account that owns it), so no profile was affected. ` +
            `It was left as the login set it; it only matters to opencode itself`,
        )
      } else {
        checked.push("opencode's active console account was not changed")
      }

      return {
        status: problems.length > 0 ? "failed" : "verified",
        checked,
        notChecked,
        problems,
        sideEffects,
        parent: after,
      }
    },
  }
}

export const opencodeReauth: ReauthAdapter = createOpencodeReauthAdapter()

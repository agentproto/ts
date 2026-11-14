/**
 * Re-authentication and expiry (AIP-69 amendment).
 *
 * Vocabulary: a PARENT account (a console login, a Claude login, …) owns zero
 * or more SUB-ACCOUNTS (orgs, workspaces, projects — `AuthProfile.subaccount`).
 * A login belongs to the parent, so re-login is per parent: one `reauth` fixes
 * every sub-account profile under it, and switching sub-account never needs one.
 *
 * This module is the generic seam, like `subaccounts.ts`: the expiry state,
 * the typed "log in again" error, the {@link ReauthAdapter} interface (one
 * small module per credential source) and a process-wide registry. Nothing here
 * names a vendor, reads a token store or spawns a process.
 */

import type { AuthProfile } from "./profile-types.js"
import { SubaccountError } from "./subaccounts.js"

/** Derived from the parent's token expiry. `unknown` = no expiry is recorded
 *  or readable (an API key, a source that does not expose one). */
export type AuthState = "ok" | "expiring" | "expired" | "unknown"

/** A session within this window of its expiry reads `expiring`. */
export const EXPIRING_WINDOW_MS = 24 * 60 * 60 * 1000
/** A session this close to its expiry is already unusable at spawn time. */
export const EXPIRY_SKEW_MS = 60_000

/** Epoch ms in, state out. `undefined`/`null`/non-finite ⇒ `unknown`. */
export function deriveAuthState(
  expiresAtMs: number | null | undefined,
  now: number = Date.now(),
  windowMs: number = EXPIRING_WINDOW_MS,
): AuthState {
  if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) return "unknown"
  const left = expiresAtMs - now
  if (left < EXPIRY_SKEW_MS) return "expired"
  if (left <= windowMs) return "expiring"
  return "ok"
}

/** The command that fixes `target` (a profile id, or a parent/source name). */
export function reauthCommand(target: string): string {
  return `agentproto auth reauth ${/^[\w.:@-]+$/.test(target) ? target : JSON.stringify(target)}`
}

export type ReauthReason =
  /** the parent's session is past its expiry */
  | "expired"
  /** no login for the parent is stored at all */
  | "missing"
  /** the provider rejected the stored session (revoked, or not a member) */
  | "rejected"

/** Machine-readable twin of the "log in again" message. Never carries a token. */
export interface ReauthHint {
  /** The exact command to run. */
  command: string
  /** The profile that needed the login, when the failure was about one. */
  profile?: string
  /** The credential source of the parent account (`opencode-console`, …). */
  source: string
  reason: ReauthReason
  parent?: { id?: string; label?: string; expiredAt?: number }
}

/**
 * A spawn (or any resolution) failed because the parent account's session is
 * expired, missing or rejected. Subclasses may narrow `code`; consumers match on
 * {@link reauthHintOf}, which also works across duplicate package copies.
 */
export class AuthReauthRequiredError extends SubaccountError {
  readonly code: string = "auth_reauth_required"
  constructor(
    readonly reauth: ReauthHint,
    message: string,
  ) {
    super(message)
  }
}

/** Duck-typed: `instanceof` does not hold across two copies of this package. */
export function reauthHintOf(err: unknown): ReauthHint | undefined {
  if (!(err instanceof Error)) return undefined
  const hint = (err as { reauth?: Partial<ReauthHint> }).reauth
  if (
    hint &&
    typeof hint.command === "string" &&
    typeof hint.source === "string" &&
    typeof hint.reason === "string"
  ) {
    return hint as ReauthHint
  }
  return undefined
}

/** What an adapter knows about the parent account behind a profile or source. */
export interface ParentAccountInfo {
  /** Opaque parent account id. Never a token. */
  id?: string
  /** Human label of the parent (its login name). Display only. */
  label?: string
  /** Some login for this parent is stored on this host. */
  loggedIn: boolean
  /** Session/token expiry, epoch ms. */
  expiresAtMs?: number
  /** The provider's own active/default account, for a provider that has one:
   *  lets a login that moves it be reported rather than silently accepted. */
  activeAccountId?: string
  /** One-way digest of the stored session; changes when a login replaces it.
   *  Compared, never displayed. */
  fingerprint?: string
  /** Every login of this provider stored on this host, so a reauth can prove
   *  it left the others alone. */
  logins?: Array<{ id: string; label?: string; fingerprint: string; expiresAtMs?: number }>
  /** The provider's own CLI renews the access token by itself, so an expired
   *  access token is not by itself a reason to log in again: the state reads
   *  `unknown` (the expiry is still reported). */
  selfRefreshing?: boolean
  /** A caveat worth showing next to the data (why no expiry, …). */
  note?: string
}

/** What a reauth runs against: a profile, or a bare parent name. */
export interface ReauthTarget {
  source: string
  profile?: AuthProfile
}

/** How the interactive login is run. The login stays interactive: it is run
 *  with inherited stdio, the rest of the flow is automated around it. */
export type ReauthLoginPlan =
  | { kind: "command"; command: string; args: string[]; description: string }
  /** The provider's CLI cannot be driven from here: say what to run instead. */
  | { kind: "manual"; instructions: string }

export interface ReauthVerification {
  /** `verified`: nothing failed and `checked` is non-empty. `unverified`: the
   *  login could not be tested at all (see `notChecked`). `failed`: see `problems`. */
  status: "verified" | "failed" | "unverified"
  /** What was tested and passed. */
  checked: string[]
  /** What could not be tested, and why. */
  notChecked: string[]
  /** What was tested and failed. Non-empty ⇒ `status` is `failed`. */
  problems: string[]
  /** What the login changed beyond the target (e.g. a moved active account). */
  sideEffects: string[]
  parent?: ParentAccountInfo
}

/** One credential source's re-login: one small module per source. */
export interface ReauthAdapter {
  /** `AuthProfile.source` this adapter owns. */
  source: string
  /** Other names accepted for the bare `<parent>` argument. */
  aliases?: readonly string[]
  /** What the parent account is called in messages. */
  displayName: string
  /** Said after a reauth: how this source's parent/sub-account model affects
   *  what the operator has to do (e.g. one login fixes every sub-account). */
  scopeNote?: string
  /** Read-only: the parent behind `target`, its login presence and expiry. */
  inspect(target: ReauthTarget): Promise<ParentAccountInfo>
  /** The login to run for the parent. `before` is {@link inspect}'s answer. */
  plan(target: ReauthTarget, before: ParentAccountInfo): ReauthLoginPlan
  /** After the login ran (or, for `manual`, after the operator says it did). */
  verify(target: ReauthTarget, before: ParentAccountInfo): Promise<ReauthVerification>
}

const adapters = new Map<string, ReauthAdapter>()

/** Register (or replace, by `source`) an adapter. Idempotent. */
export function registerReauthAdapter(adapter: ReauthAdapter): void {
  adapters.set(adapter.source, adapter)
}

export function unregisterReauthAdapter(source: string): boolean {
  return adapters.delete(source)
}

export function listReauthAdapters(): ReauthAdapter[] {
  return [...adapters.values()]
}

/** By exact source, else by alias. */
export function findReauthAdapter(name: string | undefined): ReauthAdapter | undefined {
  if (name === undefined) return undefined
  return (
    adapters.get(name) ?? listReauthAdapters().find(a => a.aliases?.includes(name))
  )
}

export interface ProfileAuthStatus {
  /** Parent token expiry, ISO-8601; null when unknown. */
  expiresAt: string | null
  state: AuthState
  /** The parent account behind the profile (a sub-account profile shows its
   *  parent's expiry and id, never a token). */
  parent?: { source: string; id?: string; label?: string; loggedIn: boolean }
  note?: string
}

/** Auth state of one profile, read from its parent account. Never throws: an
 *  unreadable parent is `unknown` with the reason in `note`. */
export async function profileAuthStatus(
  profile: AuthProfile,
  opts: { now?: number; windowMs?: number } = {},
): Promise<ProfileAuthStatus> {
  const adapter = findReauthAdapter(profile.source)
  if (!adapter) return { expiresAt: null, state: "unknown" }
  let info: ParentAccountInfo
  try {
    info = await adapter.inspect({ source: adapter.source, profile })
  } catch (err) {
    return {
      expiresAt: null,
      state: "unknown",
      parent: { source: adapter.source, loggedIn: false },
      note: `parent account unreadable: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const expiresAt = info.expiresAtMs !== undefined ? new Date(info.expiresAtMs).toISOString() : null
  // A missing login is a state of its own: nothing to spawn with.
  const state: AuthState = !info.loggedIn
    ? "expired"
    : info.selfRefreshing
      ? "unknown"
      : deriveAuthState(info.expiresAtMs, opts.now, opts.windowMs)
  return {
    expiresAt,
    state,
    parent: {
      source: adapter.source,
      ...(info.id !== undefined ? { id: info.id } : {}),
      ...(info.label !== undefined ? { label: info.label } : {}),
      loggedIn: info.loggedIn,
    },
    ...(info.note !== undefined ? { note: info.note } : {}),
  }
}

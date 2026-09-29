import { defaultAuthSignalRegistry, type AuthSignalRegistry } from "./auth-signals.js"
import { ChromeIdentityError } from "./errors.js"
import type { SessionIdentity, SessionInject, ChromeProfileInject } from "./descriptor.js"
import { isChromeProfileInject } from "./descriptor.js"
import { isKnown } from "./known.js"
import { scanChromeIdentities, type ChromeIdentity, type LocalBrowserSessionOptions } from "./local-session.js"

export interface ChromeIdentityOptions {
  /** Pre-scanned identities. Injectable so tests never scan a real profile. Scanned lazily when absent. */
  scan?: ChromeIdentity[]
  authSignals?: AuthSignalRegistry
  /** Options for the lazy scan (`chromeRoot` etc). */
  scanOptions?: LocalBrowserSessionOptions
  /** Receives non-fatal warnings (never cookie values). Default: dropped. */
  warn?: (message: string) => void
}

/** Three-valued verdict for one domain. `unknown` must never be treated as `authed`. */
export type DomainAuthSignal = "authed" | "not-authed" | "unknown"

/** {@link DomainAuthSignal} plus `not-checked`: the state where no live auth guard applies at all. */
export type SessionAuthState = DomainAuthSignal | "not-checked"

export interface SessionAuthDescription {
  state: SessionAuthState
  message: string
}

/** Classify `domain` for `found`: `unknown` when no detector is registered or the cookie read failed. */
export function domainAuthSignal(
  domain: string,
  found: ChromeIdentity,
  registry: AuthSignalRegistry = defaultAuthSignalRegistry,
): DomainAuthSignal {
  if (!isKnown(found.domainsAuthed)) return "unknown"
  if (!registry.isKnownDomain(domain)) return "unknown"
  return found.domainsAuthed.known.includes(registry.canonicalDomain(domain)) ? "authed" : "not-authed"
}

function wantDomains(inject: ChromeProfileInject, registry: AuthSignalRegistry): string[] {
  return [...new Set(inject.domains.map(d => registry.canonicalDomain(d)))]
}

/** Human label for a Chrome identity: friendly name, email, and the dir key. */
export function chromeIdentityLabel(s: ChromeIdentity): string {
  const who = s.name ?? s.email ?? "?"
  const email = s.email && s.email !== s.name ? ` (${s.email})` : ""
  const dir = s.name && s.name !== s.profile ? ` [${s.profile}]` : ""
  return `"${who}"${email}${dir}`
}

function scanFor(inject: ChromeProfileInject, opts: ChromeIdentityOptions): ChromeIdentity[] {
  return (
    opts.scan ??
    scanChromeIdentities({
      ...opts.scanOptions,
      ...(opts.authSignals ? { authSignals: opts.authSignals } : {}),
      extraDomains: inject.domains,
    })
  )
}

/**
 * Which Chrome profile a chrome-profile session's cookies should actually be
 * read from: a still-valid pin wins; otherwise a profile authed for the domain
 * AND on the same Google account; otherwise the pin unchanged. Never heals to a
 * different account.
 */
export function resolveChromeProfile(
  inject: SessionInject,
  identity?: SessionIdentity,
  opts: ChromeIdentityOptions = {},
): string | undefined {
  if (!isChromeProfileInject(inject)) return undefined
  const registry = opts.authSignals ?? defaultAuthSignalRegistry
  const ids = opts.scan ?? scanChromeIdentities({ ...opts.scanOptions, authSignals: registry })
  const pinned = inject.profile
  const want = wantDomains(inject, registry)
  const authed = (s: ChromeIdentity): boolean => {
    const da = s.domainsAuthed
    return isKnown(da) && want.some(d => da.known.includes(d))
  }
  const pin = ids.find(s => s.profile === pinned)
  if (pin && authed(pin)) return pinned
  const email = identity?.account
  if (email) {
    const sameAccount = ids.find(s => s.email === email && authed(s))
    if (sameAccount) return sameAccount.profile
  }
  return pinned
}

/**
 * Pin guard for chrome-sourced sessions: the profile exists and carries a valid
 * auth signal for the declared domain. Throws {@link ChromeIdentityError} on a
 * hard mismatch. A domain with no registered detector is `unknown`: it falls
 * back to host presence and is never reported as authed.
 */
export function verifyChromeIdentity(
  inject: SessionInject,
  identity?: SessionIdentity,
  opts: ChromeIdentityOptions = {},
): void {
  if (!isChromeProfileInject(inject)) return
  const registry = opts.authSignals ?? defaultAuthSignalRegistry
  const target = inject.profile ?? identity?.profile
  if (!target) return
  const ids = scanFor(inject, opts)
  const found = ids.find(s => s.profile === target)
  if (!found) {
    const avail = ids.map(s => `${s.profile} (${s.name ?? s.email ?? "?"})`).join(", ")
    throw new ChromeIdentityError(`chrome profile "${target}" not found; available: ${avail || "none"}`)
  }
  if (identity?.account && found.email && found.email !== identity.account) {
    opts.warn?.(`profile "${target}" is now ${found.email}, session was pinned to ${identity.account}; using the live account`)
  }
  const want = wantDomains(inject, registry)

  if (!isKnown(found.domainsAuthed)) {
    throw new ChromeIdentityError(
      `couldn't read ${chromeIdentityLabel(found)}'s cookie store, so a live ` +
        `${want.join("/")} login can't be confirmed (${found.domainsAuthed.unknown}). ` +
        `Chrome may be holding the Cookies DB lock: fully quit and reopen Chrome, then retry. ` +
        `This is NOT "not logged in".`,
    )
  }

  const signals = want.map(d => domainAuthSignal(d, found, registry))
  if (signals.includes("authed")) return

  if (signals.includes("not-authed")) {
    const authedProfiles = ids.filter(s => {
      const da = s.domainsAuthed
      return isKnown(da) && want.some(d => da.known.includes(d))
    })
    const hint = authedProfiles.length
      ? ` A valid ${want.join("/")} login IS present in: ${authedProfiles.map(chromeIdentityLabel).join(", ")}` +
        `; re-login to ${want.join("/")} in ${chromeIdentityLabel(found)}, or re-pin this session to "${authedProfiles[0]!.profile}".`
      : ` No profile is logged into ${want.join("/")}; log in first.`
    throw new ChromeIdentityError(`${chromeIdentityLabel(found)} has no valid ${want.join("/")} login (only stale crumbs).${hint}`)
  }

  const hasAnyCookie = want.some(d => found.domainsLoggedIn.includes(d))
  if (!hasAnyCookie) {
    throw new ChromeIdentityError(
      `${chromeIdentityLabel(found)} carries no cookies at all for ${want.join("/")}; no auth signal is registered ` +
        `for it (register a detector on the AuthSignalRegistry for a real check), and Chrome's on-disk cookie store ` +
        `holds nothing for it either. If you ARE logged in, Chrome may still be buffering the cookie in memory: ` +
        `fully quit and reopen Chrome, then retry.`,
    )
  }
  opts.warn?.(
    `no auth signal registered for ${want.join("/")}; cannot confirm a live login, proceeding on cookie presence only`,
  )
}

/**
 * What {@link verifyChromeIdentity} established, without throwing, so a renderer
 * can tell "confirmed" from every shade of "not confirmed". Only `authed` should
 * earn a checkmark. A heuristic (cookie name and expiry, no network).
 */
export function describeSessionAuth(
  inject: SessionInject,
  identity?: SessionIdentity,
  opts: ChromeIdentityOptions = {},
): SessionAuthDescription {
  if (!isChromeProfileInject(inject)) {
    return {
      state: "not-checked",
      message:
        `not checked: the "${inject.from}" transport carries no live auth-cookie guard ` +
        `(only "chrome-profile" sessions are inspected); a resolvable session is the only signal available here`,
    }
  }
  const registry = opts.authSignals ?? defaultAuthSignalRegistry
  const target = inject.profile ?? identity?.profile
  if (!target) return { state: "not-checked", message: "not checked: no profile pinned to verify against" }
  const ids = scanFor(inject, opts)

  const preScan = ids.find(s => s.profile === target)
  if (preScan && !isKnown(preScan.domainsAuthed)) {
    return {
      state: "unknown",
      message:
        `unknown: couldn't read ${chromeIdentityLabel(preScan)}'s cookie store (${preScan.domainsAuthed.unknown}); ` +
        `Chrome may hold the DB lock, quit and reopen it. Not "not logged in".`,
    }
  }
  try {
    verifyChromeIdentity(inject, identity, { ...opts, scan: ids })
  } catch (e) {
    return { state: "not-authed", message: e instanceof Error ? e.message : String(e) }
  }
  const found = ids.find(s => s.profile === target)!
  const want = wantDomains(inject, registry)
  if (want.some(d => domainAuthSignal(d, found, registry) === "authed")) {
    return {
      state: "authed",
      message: `profile present and logged in: live ${want.join("/")} auth cookie confirmed in ${chromeIdentityLabel(found)}`,
    }
  }
  return {
    state: "unknown",
    message: `unknown: no auth signal registered for ${want.join("/")}; proceeding on cookie presence only, not a verified login`,
  }
}

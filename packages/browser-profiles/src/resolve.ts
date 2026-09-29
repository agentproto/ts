import { existsSync } from "node:fs"
import { readFileSync } from "node:fs"
import type { BrowserDriver } from "@agentproto/driver-browser"
import { z } from "zod"
import { defaultAuthSignalRegistry, type AuthSignalRegistry } from "./auth-signals.js"
import { openSession, type CamofoxSession, type OpenSessionOptions } from "./camofox-session.js"
import { resolveChromeProfile, verifyChromeIdentity } from "./chrome-identity.js"
import { dedupeCookies, domainMatches, toSessionCookie, type RawCookie, type SessionCookie } from "./cookie.js"
import {
  chromeCookieStrategyOf,
  injectKindOf,
  isChromeCookieStrategy,
  isChromeProfileInject,
  isFileInject,
  isSourceInject,
  isSourceStrategy,
  ownedStorageStatePath,
  selectResolutionStrategy,
  type ChromeCookieStrategy,
  type ChromeProfileInject,
  type SessionDescriptor,
  type SessionInject,
  type Strategy,
} from "./descriptor.js"
import { AccountSwitcherMissingError, SessionResolveError } from "./errors.js"
import { createLocalBrowserSession, scanChromeIdentities, type LocalBrowserSessionOptions } from "./local-session.js"
import { createSessionSourceRegistry, type SessionSourceRegistry } from "./session-sources.js"

/**
 * Optional hook that rewrites a gathered jar so `userId` is the active
 * sub-account on `platform` (for profiles logged into several accounts of one
 * site). Policy about HOW to switch lives with the host; the default is none.
 */
export type AccountSwitcher = (platform: string, jar: SessionCookie[], userId: string) => SessionCookie[]

export interface ResolveSessionDeps {
  /** Single driver, used when a chrome session names no profile. */
  driver?: BrowserDriver
  /** Per-profile driver factory (the multi-account seam). Preferred over `driver`. */
  driverFor?: (profile: string) => BrowserDriver | Promise<BrowserDriver>
  /** Where registered-source cookies come from. Default: an empty registry. */
  sources?: SessionSourceRegistry
  /** Optional sub-account switcher. Never called unless a chrome-profile inject pins an `account`. */
  accountSwitcher?: AccountSwitcher
  /** Per-site "signed in" detectors. Default: {@link defaultAuthSignalRegistry}. */
  authSignals?: AuthSignalRegistry
  /** Chrome scanning options (`chromeRoot`, `safeStoragePassword`, ...). */
  local?: LocalBrowserSessionOptions
  /** Camofox opener. Default: {@link openSession}. Injectable so tests need no network. */
  openCamofox?: (opts: OpenSessionOptions) => Promise<CamofoxSession>
  /** Non-fatal warnings (never cookie values). Default: dropped. */
  warn?: (message: string) => void
}

/** What a descriptor resolves to: a chrome driver, or a live camofox session. */
export type ResolvedSession =
  | { backend: "chrome"; driver: BrowserDriver }
  | { backend: "camofox"; session: CamofoxSession }

const rawCookieSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    domain: z.string(),
    path: z.string().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.string().optional(),
    expires: z.number().optional(),
    expirationDate: z.number().optional(),
    session: z.boolean().optional(),
  })
  .loose()

const rawCookieFileSchema = z.union([
  z.array(rawCookieSchema),
  z.object({ cookies: z.array(rawCookieSchema).optional() }).loose(),
])

/** Read a cookie-file jar, domain-scoped. Malformed or foreign JSON degrades to an empty jar. */
function gatherFromFile(path: string, domains: readonly string[]): SessionCookie[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw new SessionResolveError(`cookie file "${path}" is not valid JSON`)
  }
  const parsed = rawCookieFileSchema.safeParse(raw)
  if (!parsed.success) throw new SessionResolveError(`cookie file "${path}" does not hold a cookie jar`)
  const arr = (Array.isArray(parsed.data) ? parsed.data : (parsed.data.cookies ?? [])) as RawCookie[]
  return dedupeCookies(arr.filter(c => domainMatches(c.domain, domains)).map(toSessionCookie))
}

async function gatherFromChromeProfile(
  args: { domains: readonly string[]; profile: string; account?: { platform: string; userId: string } },
  deps: ResolveSessionDeps,
): Promise<SessionCookie[]> {
  if (!args.profile) {
    const avail = scanChromeIdentities({ ...deps.local, ...(deps.authSignals ? { authSignals: deps.authSignals } : {}) })
      .map(s => `${s.profile} (${s.name ?? s.email ?? "?"})`)
      .join(", ")
    throw new SessionResolveError(
      `chrome-profile source needs an explicit "profile" (multiple accounts exist); pick one: ${avail || "none"}`,
    )
  }
  const provider = createLocalBrowserSession({
    ...deps.local,
    ...(deps.authSignals ? { authSignals: deps.authSignals } : {}),
  })
  const out: SessionCookie[] = []
  for (const domain of args.domains) {
    const payload = await provider.getDecryptedForDomain(domain, args.profile)
    for (const c of payload?.cookies ?? []) out.push(c)
  }
  const jar = dedupeCookies(out)
  if (!args.account) return jar
  if (!deps.accountSwitcher) throw new AccountSwitcherMissingError(args.account.platform)
  return deps.accountSwitcher(args.account.platform, jar, args.account.userId)
}

/**
 * Cookies for a `chrome-cookie` strategy. A file-sourced descriptor keeps its
 * cookie path in the legacy `file` inject, so `desc` is consulted to recover it.
 */
export async function gatherCookiesForStrategy(
  strategy: Strategy,
  desc: SessionDescriptor,
  deps: ResolveSessionDeps = {},
): Promise<SessionCookie[]> {
  if (!isChromeCookieStrategy(strategy)) {
    throw new SessionResolveError(`no cookies to gather for "${strategy.kind}" source`)
  }
  if (desc.inject && isFileInject(desc.inject)) return gatherFromFile(desc.inject.path, desc.inject.domains)
  return gatherFromChromeProfile(
    {
      domains: strategy.domains,
      profile: strategy.profile,
      ...(strategy.account ? { account: strategy.account } : {}),
    },
    deps,
  )
}

/** Gather cookies for a legacy `SessionInject` (chrome-profile or file only). */
export async function gatherCookies(inject: SessionInject, deps: ResolveSessionDeps = {}): Promise<SessionCookie[]> {
  if (isFileInject(inject)) return gatherFromFile(inject.path, inject.domains)
  if (isChromeProfileInject(inject)) return gatherFromChromeProfile(inject, deps)
  throw new SessionResolveError(`no cookies to gather for "${inject.from}" source`)
}

/** Turn a saved descriptor into a live session. */
export async function resolveSession(desc: SessionDescriptor, deps: ResolveSessionDeps = {}): Promise<ResolvedSession> {
  const open = deps.openCamofox ?? openSession
  const sources = deps.sources ?? createSessionSourceRegistry()
  const registry = deps.authSignals ?? defaultAuthSignalRegistry

  if (desc.backend === "chrome") {
    const profile = desc.identity?.profile
    const driver = profile && deps.driverFor ? await deps.driverFor(profile) : deps.driver
    if (!driver) {
      const hint = profile
        ? `deps.driverFor("${profile}") or deps.driver`
        : `deps.driver (or set identity.profile plus deps.driverFor for multi-account)`
      throw new SessionResolveError(`session "${desc.id}": backend "chrome" needs a live BrowserDriver: ${hint}`)
    }
    return { backend: "chrome", driver }
  }

  const selected = selectResolutionStrategy(desc)
  const kind = selected?.kind ?? (desc.inject ? injectKindOf(desc.inject.from) : undefined)
  if (!kind) throw new SessionResolveError(`session "${desc.id}": backend "camofox" needs inject{ from, domains }`)

  const openWith = async (extra: Omit<OpenSessionOptions, "userId" | "base" | "url">): Promise<ResolvedSession> => ({
    backend: "camofox",
    session: await open({
      userId: desc.id,
      ...(desc.base ? { base: desc.base } : {}),
      ...(desc.url ? { url: desc.url } : {}),
      ...extra,
    }),
  })

  if (kind === "authed-storageState") {
    const profilePath = ownedStorageStatePath(desc.id)
    return openWith({
      injectCookies: false,
      ...(existsSync(profilePath) ? { storageState: profilePath } : {}),
      keepAlive: true,
    })
  }

  if (kind === "chrome-cookie") return resolveChromeCookie(desc, selected, deps, openWith, registry)

  // Any other kind is a registered source: the registry resolves it or throws a typed error.
  const ref =
    selected && isSourceStrategy(selected)
      ? { sessionRef: selected.sessionRef, domains: selected.domains }
      : desc.inject && isSourceInject(desc.inject)
        ? { sessionRef: desc.inject.sessionRef, domains: desc.inject.domains }
        : undefined
  if (!ref) throw new SessionResolveError(`session "${desc.id}": "${kind}" source carries no sessionRef/domains`)
  const cookies = await sources.materialize(kind, ref)
  if (cookies.length === 0) {
    throw new SessionResolveError(
      `session "${desc.id}": the "${kind}" source returned no cookies for ${ref.domains.join("/")} ` +
        `(ref "${ref.sessionRef}"): revoked, expired, or not granted`,
    )
  }
  return openWith({ cookies: dedupeCookies(cookies), injectCookies: true, keepAlive: true })
}

async function resolveChromeCookie(
  desc: SessionDescriptor,
  selected: Strategy | undefined,
  deps: ResolveSessionDeps,
  openWith: (extra: Omit<OpenSessionOptions, "userId" | "base" | "url">) => Promise<ResolvedSession>,
  registry: AuthSignalRegistry,
): Promise<ResolvedSession> {
  // A file-backed chrome-cookie carries its cookies in the legacy `file` inject:
  // no Chrome dir to heal or verify, and an empty jar is not an error.
  if (desc.inject && isFileInject(desc.inject)) {
    const cookies = await gatherCookies(desc.inject, deps)
    return openWith({ cookies, injectCookies: true, keepAlive: true })
  }
  const chromeStrat: ChromeCookieStrategy | undefined =
    selected && isChromeCookieStrategy(selected)
      ? selected
      : desc.inject && isChromeProfileInject(desc.inject)
        ? chromeCookieStrategyOf(desc.inject, desc.identity)
        : undefined
  if (!chromeStrat) throw new SessionResolveError(`session "${desc.id}": backend "camofox" needs inject{ from, domains }`)

  const baseInject: ChromeProfileInject = {
    from: "chrome-profile",
    domains: chromeStrat.domains,
    profile: chromeStrat.profile,
    ...(chromeStrat.account ? { account: chromeStrat.account } : {}),
  }
  const chromeOpts = {
    authSignals: registry,
    ...(deps.local ? { scanOptions: deps.local } : {}),
    ...(deps.warn ? { warn: deps.warn } : {}),
  }
  const healed = resolveChromeProfile(baseInject, desc.identity, chromeOpts)
  const inject: ChromeProfileInject = healed && healed !== baseInject.profile ? { ...baseInject, profile: healed } : baseInject
  if (inject !== baseInject) {
    deps.warn?.(
      `"${desc.id}": pinned profile "${chromeStrat.profile}" has no live ${inject.domains.join("/")} login; ` +
        `healed to "${inject.profile}" (same account)`,
    )
  }
  verifyChromeIdentity(inject, desc.identity, chromeOpts)
  const healedStrat: ChromeCookieStrategy =
    inject.profile !== chromeStrat.profile ? { ...chromeStrat, profile: inject.profile } : chromeStrat
  const cookies = await gatherCookiesForStrategy(healedStrat, desc, deps)
  if (cookies.length === 0) {
    throw new SessionResolveError(
      `session "${desc.id}": no cookies for ${healedStrat.domains.join("/")} in profile ` +
        `"${healedStrat.profile || "(any)"}": not logged in, or wrong profile`,
    )
  }
  return openWith({ cookies, injectCookies: true, keepAlive: true })
}


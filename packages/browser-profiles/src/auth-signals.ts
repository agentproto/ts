/**
 * Per-site "am I signed in" detectors, injected. The package ships none: which
 * cookie name proves a live login on a given site is site knowledge, so the host
 * registers it. A detector sees cookie NAMES and expiry only, never values.
 */

/** Cookie metadata a detector may look at. No value, by design. */
export interface AuthCookieMeta {
  name: string
  /** Host key without the leading dot, lowercased. */
  host: string
  /** Unix seconds; `undefined` means a session cookie (valid while the browser is open). */
  expiresUnix: number | undefined
}

export interface SiteAuthSignal {
  /** Registrable domain the detector is about, e.g. `"example.com"`. */
  readonly domain: string
  /** Other hosts whose cookies count as this domain (e.g. a renamed site). */
  readonly aliases?: readonly string[]
  /** Cookie NAME(s) that prove a live login. Any one present and unexpired counts. Ignored when `detect` is set. */
  readonly cookieNames?: readonly string[]
  /** Custom detector over this domain's cookie metadata; overrides the `cookieNames` rule. */
  readonly detect?: (cookies: readonly AuthCookieMeta[], nowMs: number) => boolean
}

export interface AuthSignalRegistry {
  register(signal: SiteAuthSignal): void
  /** Domains with a registered detector: the KNOWN side of the known/unknown split. */
  knownDomains(): readonly string[]
  isKnownDomain(domain: string): boolean
  /** Map an alias host onto its registered domain; anything else passes through lowercased. */
  canonicalDomain(domain: string): string
  /** Other hosts that count as the same site as `domain` (its aliases, or its canonical domain plus siblings). */
  equivalentDomains(domain: string): readonly string[]
  /** Whether `host` belongs to `domain` (or one of its aliases). */
  hostBelongsTo(host: string, domain: string): boolean
  /** Run the detector for `domain` over the profile's cookie metadata. `false` when no detector is registered. */
  isAuthed(domain: string, cookies: readonly AuthCookieMeta[], nowMs: number): boolean
}

const norm = (d: string): string => d.replace(/^\./, "").toLowerCase()

const hostMatches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

export function createAuthSignalRegistry(initial: readonly SiteAuthSignal[] = []): AuthSignalRegistry {
  const signals = new Map<string, SiteAuthSignal>()

  const registry: AuthSignalRegistry = {
    register(signal) {
      signals.set(norm(signal.domain), signal)
    },
    knownDomains: () => [...signals.keys()],
    isKnownDomain: domain => signals.has(norm(domain)),
    canonicalDomain(domain) {
      const d = norm(domain)
      if (signals.has(d)) return d
      for (const s of signals.values()) {
        if (s.aliases?.some(a => norm(a) === d)) return norm(s.domain)
      }
      return d
    },
    equivalentDomains(domain) {
      const d = norm(domain)
      const canon = registry.canonicalDomain(d)
      const s = signals.get(canon)
      const all = [canon, ...(s?.aliases ?? []).map(norm)]
      return [...new Set(all)].filter(x => x !== d)
    },
    hostBelongsTo(host, domain) {
      const h = norm(host)
      const s = signals.get(norm(domain))
      const names = [norm(domain), ...(s?.aliases ?? []).map(norm)]
      return names.some(n => hostMatches(h, n))
    },
    isAuthed(domain, cookies, nowMs) {
      const s = signals.get(norm(domain))
      if (!s) return false
      const mine = cookies.filter(c => registry.hostBelongsTo(c.host, domain))
      if (s.detect) return s.detect(mine, nowMs)
      const names = s.cookieNames ?? []
      return mine.some(c => names.includes(c.name) && (c.expiresUnix === undefined || c.expiresUnix > nowMs / 1000))
    },
  }
  for (const s of initial) registry.register(s)
  return registry
}

/** Process-wide default registry (empty). Hosts register their detectors here or pass their own. */
export const defaultAuthSignalRegistry: AuthSignalRegistry = createAuthSignalRegistry()

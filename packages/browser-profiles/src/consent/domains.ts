import { GrantDomainError } from "./errors.js"

/** The AIP-63 `domain` pattern: lowercase, ASCII or punycode, at least two labels. */
export const GRANT_DOMAIN_PATTERN =
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/

/**
 * A compact subset of the Public Suffix List: the multi-label suffixes people
 * actually paste, plus the shared hosting suffixes where every subdomain is a
 * different owner. It is NOT the whole list; pass `isPublicSuffix` to
 * {@link validateGrantDomains} to check against the real one.
 */
const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "org.nz", "net.nz", "govt.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "go.kr",
  "com.br", "net.br", "org.br", "gov.br",
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "com.mx", "com.ar", "com.tr", "com.tw", "com.hk", "com.sg", "com.my", "com.ph", "com.vn",
  "co.in", "net.in", "org.in", "gov.in", "co.id", "co.th", "co.il", "co.za", "com.ua", "com.pl", "com.es", "com.pt",
  "github.io", "gitlab.io", "herokuapp.com", "appspot.com", "vercel.app", "netlify.app", "pages.dev",
  "workers.dev", "web.app", "firebaseapp.com", "blogspot.com", "cloudfront.net", "azurewebsites.net",
  "s3.amazonaws.com", "fly.dev", "onrender.com", "ngrok.io", "trycloudflare.com",
])

export interface GrantDomainPolicy {
  /** Extra public-suffix check (for example one backed by the full Public Suffix List). */
  isPublicSuffix?: (domain: string) => boolean
}

/** True for a suffix in the embedded subset. */
export function isKnownPublicSuffix(domain: string): boolean {
  return PUBLIC_SUFFIXES.has(domain)
}

/**
 * Validate a grant's domain list against AIP-63 C2 and return it lowercased and
 * de-duplicated. Rejects `*`, `*.x`, a leading dot, an empty list, a bare TLD,
 * a public suffix and anything that is not a plain host, each with a typed
 * {@link GrantDomainError}. A grant covers the named domain and its subdomains.
 */
export function validateGrantDomains(input: readonly string[], policy: GrantDomainPolicy = {}): string[] {
  if (input.length === 0) throw new GrantDomainError("empty")
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== "string" || raw.length === 0) throw new GrantDomainError("invalid", String(raw))
    if (raw.includes("*")) throw new GrantDomainError("wildcard", raw)
    if (raw.startsWith(".")) throw new GrantDomainError("leading-dot", raw)
    const domain = raw.toLowerCase()
    if (!domain.includes(".")) throw new GrantDomainError("bare-tld", raw)
    if (domain.length > 253 || !GRANT_DOMAIN_PATTERN.test(domain)) throw new GrantDomainError("invalid", raw)
    if (isKnownPublicSuffix(domain) || policy.isPublicSuffix?.(domain) === true) {
      throw new GrantDomainError("public-suffix", raw)
    }
    if (!out.includes(domain)) out.push(domain)
  }
  return out
}

/** True when `host` is `domain` or one of its subdomains. */
export function hostCoveredBy(host: string, domain: string): boolean {
  const h = host.replace(/^\./, "").toLowerCase()
  return h === domain || h.endsWith(`.${domain}`)
}

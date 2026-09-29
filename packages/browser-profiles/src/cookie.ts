/** A cookie to inject into a browser session (camofox and Playwright shape). `value` is a secret: never log it. */
export interface SessionCookie {
  name: string
  value: string
  domain: string
  path?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
  expires?: number
}

/** The loose shape a cookie file or a decrypted jar yields before normalising. */
export interface RawCookie {
  name: string
  value: string
  domain: string
  path?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
  expires?: number
  expirationDate?: number
  session?: boolean
}

export function domainMatches(domain: string | undefined, domains: readonly string[]): boolean {
  const h = String(domain ?? "")
    .replace(/^\./, "")
    .toLowerCase()
  return domains.some(d => h === d || h.endsWith(`.${d}`))
}

export function toSessionCookie(c: RawCookie): SessionCookie {
  const o: SessionCookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
  }
  if (c.httpOnly != null) o.httpOnly = c.httpOnly
  if (c.secure != null) o.secure = c.secure
  if (c.sameSite) o.sameSite = String(c.sameSite)
  const exp = c.expires ?? c.expirationDate
  if (!c.session && exp) o.expires = Math.floor(exp)
  return o
}

/** Drop duplicates by (name, domain, path); aliased domains otherwise yield the same cookie twice. */
export function dedupeCookies(cookies: readonly SessionCookie[]): SessionCookie[] {
  const seen = new Map<string, SessionCookie>()
  for (const c of cookies) seen.set(`${c.name}|${c.domain}|${c.path}`, c)
  return [...seen.values()]
}

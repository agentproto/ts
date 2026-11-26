/**
 * Return URLs of a checkout or a portal session, checked against an allow
 * list of origins before any call to the rail (SET-10). Shared by the
 * provider packages so that every one of them refuses the same URLs.
 */

/**
 * Returns `url` when its origin (scheme, host and port) is exactly one of
 * `allowedOrigins`; throws otherwise. A relative URL, an URL that does not
 * parse and a scheme other than http(s) are refused; an empty list refuses
 * everything.
 */
export function assertReturnUrl(url: string, allowedOrigins: readonly string[]): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("return URL is not an absolute URL")
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`return URL scheme '${parsed.protocol}' is not http(s)`)
  if (parsed.username !== "" || parsed.password !== "") throw new Error("return URL carries credentials")
  const allowed = new Set(
    allowedOrigins.flatMap(o => {
      try {
        return [new URL(o).origin]
      } catch {
        return []
      }
    }),
  )
  if (!allowed.has(parsed.origin)) throw new Error(`return URL origin '${parsed.origin}' is not in the allowed origins`)
  return url
}

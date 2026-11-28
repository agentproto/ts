import {
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  MissingSecretError,
  type SecretsPort,
  TransportError,
} from "../transport"

/** How the secret is sent. */
export type ApiAuth =
  | { type: "bearer"; secret: string }
  /** `value` is `prefix + secret`; `prefix` defaults to nothing. */
  | { type: "header"; name: string; secret: string; prefix?: string }
  | { type: "query"; name: string; secret: string }

export interface ApiTransportOptions {
  /** Transport the requests go through (usually `createHttpTransport()`). */
  http: HttpTransport
  secrets: SecretsPort
  auth: ApiAuth
}

const REDACTED = "[redacted]"

/**
 * `api` transport: adds the auth header (or query parameter) read from the
 * `SecretsPort` on every request, then delegates to `http`.
 *
 * - A missing or empty secret throws `MissingSecretError` before any request;
 *   the engine records the task as `skipped`.
 * - The secret value never leaves this function: errors and responses are
 *   rebuilt with the value replaced by `[redacted]` in the message, URL and
 *   body, the underlying error object is dropped, and a query-parameter secret
 *   is removed from the returned `url`.
 * - A header secret is marked as a credential header, so the HTTP transport
 *   drops it if a redirect leaves the origin.
 */
export function createApiTransport(options: ApiTransportOptions): HttpTransport {
  const { http, secrets, auth } = options
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const secret = await secrets.get(auth.secret)
      if (!secret) throw new MissingSecretError(auth.secret)
      let url = req.url
      const headers: Record<string, string> = { ...(req.headers ?? {}) }
      const credentialHeaders = [...(req.credentialHeaders ?? [])]
      if (auth.type === "query") {
        const u = new URL(url)
        u.searchParams.set(auth.name, secret)
        url = u.toString()
      } else {
        const name = auth.type === "bearer" ? "Authorization" : auth.name
        for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) delete headers[k]
        headers[name] = auth.type === "bearer" ? `Bearer ${secret}` : `${auth.prefix ?? ""}${secret}`
        credentialHeaders.push(name.toLowerCase())
      }
      try {
        const res = await http.request({ ...req, url, headers, credentialHeaders })
        return { ...res, url: clean(res.url, auth, secret) }
      } catch (e) {
        throw redactError(e, auth, secret)
      }
    },
  }
}

function clean(url: string, auth: ApiAuth, secret: string): string {
  let out = url
  if (auth.type === "query") {
    try {
      const u = new URL(url)
      u.searchParams.delete(auth.name)
      out = u.toString()
    } catch {
      // not a URL: fall through to the plain replacement
    }
  }
  return scrub(out, secret)
}

function scrub(text: string, secret: string): string {
  // The raw value and the two usual URL encodings (percent and form).
  const forms = new Set([secret, encodeURIComponent(secret), new URLSearchParams({ k: secret }).toString().slice(2)])
  let out = text
  for (const f of forms) out = out.split(f).join(REDACTED)
  return out
}

function redactError(e: unknown, auth: ApiAuth, secret: string): unknown {
  if (e instanceof MissingSecretError) return e
  if (e instanceof TransportError) {
    let body = e.body
    if (body) {
      const text = new TextDecoder().decode(body)
      const clean = scrub(text, secret)
      if (clean !== text) body = new TextEncoder().encode(clean)
    }
    return new TransportError(e.cause, scrub(e.message, secret), {
      status: e.status,
      url: e.url === undefined ? undefined : clean(e.url, auth, secret),
      body,
      ext: e.ext,
    })
  }
  const message = e instanceof Error ? scrub(e.message, secret) : "request failed"
  return new TransportError("network", message)
}

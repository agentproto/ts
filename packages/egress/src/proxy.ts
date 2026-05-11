/**
 * Transport-agnostic egress proxy core.
 *
 * Takes a normalized request shape + a provider lookup + a secret
 * resolver, returns a normalized rewritten request ready to forward.
 * Doesn't know about Hono, Express, or any HTTP framework — hosts
 * adapt their server framework to this shape.
 *
 * Why split: keeps the proxy logic testable in isolation + lets new
 * runtime hosts (Bun, Deno, Cloudflare Workers, etc.) reuse the same
 * core without dragging in node:http or similar.
 */

import {
  substituteSecrets,
  SecretSubstitutionError,
  type SecretResolver,
  type SubstitutionRecord,
} from "@agentproto/secrets/exposure"
import type { EgressProvider } from "./providers.js"

/** Body type permissive enough for any reasonable runtime — node `fetch`,
 *  Bun, Deno, Cloudflare Workers, browser. We don't pull in DOM types
 *  (that would expose them to every consumer of this package); the
 *  host's `fetch` call accepts whatever shape it understands. */
export type EgressBody =
  | string
  | Uint8Array
  | ArrayBuffer
  | ReadableStream<Uint8Array>
  | { stream(): ReadableStream<Uint8Array> }   // Blob-shaped

/** Inbound request shape — host-framework-agnostic. */
export interface EgressRequest {
  /** Provider id from the URL — `/egress/<providerId>/...`. */
  providerId: string
  /** Path inside the provider — what comes after `/egress/<providerId>`.
   *  Should start with `/`. */
  path: string
  /** HTTP method, uppercase. */
  method: string
  /** Header bag — string values only (multi-value headers should be
   *  pre-joined by the host framework). */
  headers: Record<string, string>
  /** Optional request body. Substitution does NOT scan the body in
   *  v0 — only headers. Body opt-in per provider lands later. */
  body?: EgressBody | null
  /** Query string verbatim (with leading `?`) or empty string. */
  search: string
}

/** Outbound, rewritten request shape — what the host fetches. */
export interface RewrittenEgressRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: EgressBody | null
  /** Audit record — names of secrets that were substituted into the
   *  outbound headers, in match order. */
  substitutions: SubstitutionRecord[]
}

export interface ProxyEgressRequestOptions {
  request: EgressRequest
  /** Provider allowlist — typically `COMMON_EGRESS_PROVIDERS` merged
   *  with host-specific entries. Unknown provider id → throws
   *  EgressError("unknown_provider"). */
  providers: Record<string, EgressProvider>
  /** Per-call secret resolver. The host wires its vault here. Returns
   *  null when a placeholder name doesn't resolve — the proxy keeps
   *  the placeholder verbatim and the upstream then 401s, which is
   *  exactly the right surface (agent learns the secret isn't allowed
   *  via the upstream's own auth-failure response). */
  resolver: SecretResolver
}

/**
 * Build the rewritten request for an inbound egress call. The host
 * uses the result with `fetch(rewritten.url, rewritten)` (or its
 * runtime's equivalent). Audit records are returned alongside so the
 * host can log per-call substitutions to its usage_events table.
 *
 * Throws `EgressError` with stable codes for the known failure modes
 * — host framework adapter maps to its own HTTP responses (typically
 * 400 / 404 / 500).
 */
export async function proxyEgressRequest(
  opts: ProxyEgressRequestOptions
): Promise<RewrittenEgressRequest> {
  const provider = opts.providers[opts.request.providerId]
  if (!provider) {
    throw new EgressError(
      "unknown_provider",
      `Unknown egress provider '${opts.request.providerId}'.`
    )
  }

  const url = buildUpstreamUrl(provider, opts.request.path, opts.request.search)

  // Substitute headers. Body left as-is for v0.
  const rewrittenHeaders: Record<string, string> = {}
  const allRecords: SubstitutionRecord[] = []
  for (const [name, value] of Object.entries(opts.request.headers)) {
    // Strip per-hop headers — they describe the ingress hop, not the
    // upstream. Standard reverse-proxy hygiene.
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    try {
      const result = await substituteSecrets(value, opts.resolver)
      rewrittenHeaders[name] = result.output
      allRecords.push(...result.replacements)
    } catch (err: unknown) {
      if (err instanceof SecretSubstitutionError) {
        // Re-raise as EgressError so host framework sees a single
        // exception class (with the original code preserved). Local
        // binding annotation works around a tsup-dts narrowing quirk
        // where `err` stays `unknown` in the d.ts pipeline despite
        // the runtime `instanceof` narrowing it for esbuild.
        const sub: SecretSubstitutionError = err
        throw new EgressError(sub.code, sub.message)
      }
      throw err
    }
  }

  // Don't drop the upstream Host header — let `fetch` populate it
  // from the URL. The original Host (the proxy's hostname) is
  // wrong for the upstream.
  delete rewrittenHeaders["host"]
  delete rewrittenHeaders["Host"]

  return {
    url,
    method: opts.request.method,
    headers: rewrittenHeaders,
    body: opts.request.body ?? null,
    substitutions: allRecords,
  }
}

function buildUpstreamUrl(
  provider: EgressProvider,
  path: string,
  search: string
): string {
  const base = provider.upstream.replace(/\/$/, "")
  const prefix = provider.pathPrefix?.replace(/\/$/, "") ?? ""
  // Ensure exactly one slash between prefix and path.
  const normPath = path.startsWith("/") ? path : `/${path}`
  return `${base}${prefix}${normPath}${search}`
}

/** Per-RFC-7230. Filtered before forwarding upstream. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

/** Stable error class for proxy-level failures. Codes:
 *   - `unknown_provider`        — providerId not in allowlist
 *   - `secret_value_empty`      — resolver returned an empty value
 *   - `secret_value_unsafe`     — resolved value contained CR/LF/NUL
 *   - `invalid_placeholder_name`— placeholder name failed regex
 */
export class EgressError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "EgressError"
  }
}

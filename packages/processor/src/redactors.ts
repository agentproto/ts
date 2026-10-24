import type { JsonValue, Redactor } from "./types.js"

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value)
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Passthrough redactor — returns the value unchanged. */
export const noneRedactor: Redactor = {
  slug: "none",
  redact(value) {
    return value
  },
}

/** Default case-insensitive deny patterns, matched if a key CONTAINS them. */
const DEFAULT_DENY_PATTERNS: readonly string[] = [
  "authorization",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api[-_]?key",
  "access[-_]?key",
  "client[-_]?secret",
  "bearer",
  "cookie",
  "session[-_]?id",
  "private[-_]?key",
  "credential",
]

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function toKeyPattern(key: string | RegExp): RegExp {
  if (key instanceof RegExp) {
    return new RegExp(key.source, key.flags.includes("i") ? key.flags : `${key.flags}i`)
  }
  return new RegExp(escapeRegExp(key), "i")
}

export interface DenyListRedactorOptions {
  readonly extraKeys?: readonly (string | RegExp)[]
  readonly placeholder?: string
}

/**
 * Deep, immutable walk that masks the VALUE of every object entry whose KEY
 * matches a deny pattern (case-insensitive substring/regex match), regardless
 * of that value's type. Recurses into nested objects and array elements.
 * Never mutates the input — always returns a new structure.
 */
export function denyListRedactor(opts: DenyListRedactorOptions = {}): Redactor {
  const placeholder = opts.placeholder ?? "[redacted]"
  const patterns: readonly RegExp[] = [
    ...DEFAULT_DENY_PATTERNS.map((pattern) => new RegExp(pattern, "i")),
    ...(opts.extraKeys ?? []).map(toKeyPattern),
  ]

  function keyIsDenied(key: string): boolean {
    return patterns.some((pattern) => pattern.test(key))
  }

  function walk(value: JsonValue): JsonValue {
    if (isJsonArray(value)) {
      return value.map((element) => walk(element))
    }
    if (isJsonObject(value)) {
      const result: { [key: string]: JsonValue } = {}
      for (const [key, entryValue] of Object.entries(value)) {
        result[key] = keyIsDenied(key) ? placeholder : walk(entryValue)
      }
      return result
    }
    return value
  }

  return {
    slug: "deny-list",
    redact(value) {
      return walk(value)
    },
  }
}

export interface TruncateRedactorOptions {
  readonly maxStringLength?: number
  readonly maxArrayLength?: number
}

/**
 * Caps long strings and long arrays so oversized payloads don't leave the
 * process. Recurses into nested objects/arrays. Never mutates the input.
 */
export function truncateRedactor(opts: TruncateRedactorOptions = {}): Redactor {
  const maxStringLength = opts.maxStringLength ?? 2000
  const maxArrayLength = opts.maxArrayLength ?? 100

  function walk(value: JsonValue): JsonValue {
    if (typeof value === "string") {
      if (value.length <= maxStringLength) {
        return value
      }
      const extra = value.length - maxStringLength
      return `${value.slice(0, maxStringLength)}…[+${extra} chars]`
    }
    if (isJsonArray(value)) {
      const walked = value.map((element) => walk(element))
      if (walked.length <= maxArrayLength) {
        return walked
      }
      const extra = walked.length - maxArrayLength
      return [...walked.slice(0, maxArrayLength), `…[+${extra} items]`]
    }
    if (isJsonObject(value)) {
      const result: { [key: string]: JsonValue } = {}
      for (const [key, entryValue] of Object.entries(value)) {
        result[key] = walk(entryValue)
      }
      return result
    }
    return value
  }

  return {
    slug: "truncate",
    redact(value) {
      return walk(value)
    },
  }
}

/**
 * Well-known secret shapes, matched inside STRING VALUES regardless of the key
 * they sit under. All patterns are prefix-anchored and linear (no nested
 * quantifiers over overlapping classes) so they can't backtrack pathologically.
 */
const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private key block (masked whole).
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  // JWT — header.payload.signature.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // OpenAI / Anthropic / Stripe-style prefixed keys: sk-, sk-ant-, sk_live_, …
  /\bsk[-_](?:ant[-_]|proj[-_]|live[-_]|test[-_])?[A-Za-z0-9]{16,}\b/g,
  // AWS access key id.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub token — ghp_/gho_/ghu_/ghs_/ghr_.
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  // Slack token.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API key.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
]

export interface ValueScanRedactorOptions {
  readonly placeholder?: string
  /** Extra whole-match secret patterns (use the `g` flag). */
  readonly extraPatterns?: readonly RegExp[]
}

/**
 * Deep, immutable walk that scans every STRING VALUE for well-known secret
 * shapes and masks the matched substring — catching a credential leaked in a
 * value whose key ISN'T denied (e.g. `{ note: "use sk-live-abc…" }`), which the
 * key-based {@link denyListRedactor} cannot see. Surrounding text is preserved,
 * and an `Authorization`-style `Bearer`/`Basic` scheme keeps the scheme word
 * while masking only the token. Never mutates the input.
 */
export function valueScanRedactor(opts: ValueScanRedactorOptions = {}): Redactor {
  const placeholder = opts.placeholder ?? "[redacted]"
  const patterns: readonly RegExp[] = [...DEFAULT_SECRET_PATTERNS, ...(opts.extraPatterns ?? [])]

  function scan(input: string): string {
    // Scheme-preserving first: keep "Bearer"/"Basic", mask the token after it.
    let out = input.replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
      (_match: string, scheme: string) => `${scheme} ${placeholder}`,
    )
    for (const pattern of patterns) {
      out = out.replace(pattern, placeholder)
    }
    return out
  }

  function walk(value: JsonValue): JsonValue {
    if (typeof value === "string") {
      return scan(value)
    }
    if (isJsonArray(value)) {
      return value.map((element) => walk(element))
    }
    if (isJsonObject(value)) {
      const result: { [key: string]: JsonValue } = {}
      for (const [key, entryValue] of Object.entries(value)) {
        result[key] = walk(entryValue)
      }
      return result
    }
    return value
  }

  return {
    slug: "value-scan",
    redact(value) {
      return walk(value)
    },
  }
}

/** Applies each redactor in order — the output of one feeds the next. */
export function chainRedactors(redactors: readonly Redactor[], slug?: string): Redactor {
  const chainSlug = slug ?? redactors.map((redactor) => redactor.slug).join("+")
  return {
    slug: chainSlug,
    redact(value, ctx) {
      return redactors.reduce((acc, redactor) => redactor.redact(acc, ctx), value)
    },
  }
}

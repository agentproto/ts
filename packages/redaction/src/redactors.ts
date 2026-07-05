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

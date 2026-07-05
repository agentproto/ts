import { chainRedactors, denyListRedactor, noneRedactor, truncateRedactor } from "./redactors.js"
import type { DenyListRedactorOptions, TruncateRedactorOptions } from "./redactors.js"
import type { JsonValue, Redactor, RedactorCatalogEntry, RedactorSpec } from "./types.js"

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Builds deny-list options from JSON. Only string `extraKeys` can round-trip
 * through JSON (a `RegExp` cannot); pass `RegExp` entries by calling
 * {@link denyListRedactor} directly instead of through the catalog.
 */
function toDenyListOptions(options: { readonly [key: string]: JsonValue }): DenyListRedactorOptions {
  const placeholderValue = options.placeholder
  const extraKeysValue = options.extraKeys
  return {
    placeholder: typeof placeholderValue === "string" ? placeholderValue : undefined,
    extraKeys: Array.isArray(extraKeysValue)
      ? extraKeysValue.filter((entry): entry is string => typeof entry === "string")
      : undefined,
  }
}

function toTruncateOptions(options: { readonly [key: string]: JsonValue }): TruncateRedactorOptions {
  const maxStringLengthValue = options.maxStringLength
  const maxArrayLengthValue = options.maxArrayLength
  return {
    maxStringLength: typeof maxStringLengthValue === "number" ? maxStringLengthValue : undefined,
    maxArrayLength: typeof maxArrayLengthValue === "number" ? maxArrayLengthValue : undefined,
  }
}

/** Static catalog of built-in redactor backends. All v1 entries are local, dependency-free transforms. */
export const REDACTOR_CATALOG: Readonly<Record<string, RedactorCatalogEntry>> = {
  none: {
    slug: "none",
    description: "Passthrough — returns the value unchanged.",
    needsCreds: false,
    build() {
      return noneRedactor
    },
  },
  "deny-list": {
    slug: "deny-list",
    description:
      "Deep, immutable walk that masks values whose object key matches a deny pattern " +
      "(credentials, tokens, cookies, etc).",
    needsCreds: false,
    build(options) {
      if (options === undefined) {
        return denyListRedactor()
      }
      if (!isJsonObject(options)) {
        throw new Error("deny-list redactor options must be a JSON object")
      }
      return denyListRedactor(toDenyListOptions(options))
    },
  },
  truncate: {
    slug: "truncate",
    description: "Caps long strings and long arrays so oversized payloads don't leave the process.",
    needsCreds: false,
    build(options) {
      if (options === undefined) {
        return truncateRedactor()
      }
      if (!isJsonObject(options)) {
        throw new Error("truncate redactor options must be a JSON object")
      }
      return truncateRedactor(toTruncateOptions(options))
    },
  },
}

function isRedactorSpecObject(
  spec: RedactorSpec,
): spec is { readonly slug: string; readonly options?: JsonValue } {
  return typeof spec === "object" && spec !== null && !Array.isArray(spec)
}

function resolveOne(slug: string, options?: JsonValue): Redactor {
  const entry = REDACTOR_CATALOG[slug]
  if (entry === undefined) {
    const known = Object.keys(REDACTOR_CATALOG).join(", ")
    throw new Error(`unknown redactor slug: ${slug} (known slugs: ${known})`)
  }
  return entry.build(options)
}

/**
 * Resolve a {@link RedactorSpec} to a concrete {@link Redactor}.
 * - `undefined` / `"none"` / `[]` resolve to {@link noneRedactor}.
 * - A slug string resolves via the catalog's `build()`; throws on unknown slugs.
 * - `{ slug, options }` resolves via the catalog's `build(options)`.
 * - An array resolves each member and chains them in order.
 */
export function resolveRedactor(spec?: RedactorSpec): Redactor {
  if (spec === undefined) {
    return noneRedactor
  }
  if (Array.isArray(spec)) {
    if (spec.length === 0) {
      return noneRedactor
    }
    return chainRedactors(spec.map((member) => resolveRedactor(member)))
  }
  if (typeof spec === "string") {
    if (spec === "none") {
      return noneRedactor
    }
    return resolveOne(spec)
  }
  if (isRedactorSpecObject(spec)) {
    return resolveOne(spec.slug, spec.options)
  }
  throw new Error("invalid redactor spec")
}

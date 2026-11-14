import { memoryFrontmatterSchema } from "./schema.js"
import {
  MEMORY_TYPES,
  type MemoryIssue,
  type MemoryValidationResult,
} from "./types.js"

export interface ValidateMemoryOptions {
  /**
   * Require the canonical fields (`schema`, `slug`, `kind`, `title`,
   * `updated_at`), as rule 1 asks of a writer creating an item. Off by
   * default: a reader MUST accept legacy items (rule 9).
   */
  canonical?: boolean
}

const CANONICAL_FIELDS = ["schema", "slug", "kind", "title", "updated_at"] as const
const LEGACY_FIELDS = ["id", "name", "type"] as const

// The codegen wraps the root and `lifetime` objects in `.strict().and(...)`
// (for the `anyOf` / `allOf` branches), and zod 4 does not report a key
// unknown to a strict object inside an intersection. Check those two
// key sets here, read from the generated schema itself.
const ROOT_KEYS = Object.keys(memoryFrontmatterSchema.def.left.shape)
const LIFETIME_KEYS = Object.keys(
  memoryFrontmatterSchema.def.left.shape.lifetime.unwrap().def.left.shape,
)

/**
 * Validate one memory/v1 document (frontmatter fields plus `body`).
 *
 * Runs MEMORY.schema.json (through the generated zod, plus the
 * `anyOf` and lifetime `if/then` branches the codegen cannot express)
 * and the AIP-72 conformance rules checkable on a single document:
 * section 2 (`kind` set), rules 1, 2, 4 and 5 as errors, rule 8 as
 * warnings. Rules 6 and 7 compare two versions of an item and belong to
 * the store; `isAllowedStatusTransition` covers rule 7's table.
 *
 * Defaults: MEMORY.schema.json gives `tags` (and `evidence.anchorsResolved`,
 * `evidence.flags`) `default: []`, and the generated zod carries it. This
 * function only checks: it never returns the parsed data, so the default
 * is never filled in. An item without `tags` stays without `tags` and
 * reads as untagged (the digest treats it as `global`, AIP-72 section 9).
 * An explicit `tags: []` validates: rule 4 rejects empty strings and empty
 * objects, not empty arrays, though a writer omits it (`defineMemory`).
 */
export function validateMemory(
  doc: unknown,
  opts: ValidateMemoryOptions = {},
): MemoryValidationResult {
  const errors: MemoryIssue[] = []
  const warnings: MemoryIssue[] = []
  if (!isPlainObject(doc)) {
    errors.push({ path: "", message: "must be an object", rule: "schema" })
    return { ok: false, errors, warnings }
  }

  const parsed = memoryFrontmatterSchema.safeParse(doc)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const base = issue.path.map(String)
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          errors.push({
            path: [...base, key].join("."),
            message: "unknown field",
            rule: "schema",
          })
        }
      } else {
        errors.push({ path: base.join("."), message: issue.message, rule: "schema" })
      }
    }
  }

  checkUnknownKeys(doc, ROOT_KEYS, "", errors)

  // anyOf: canonical base fields, or the legacy id/name/type trio.
  const missingCanonical = CANONICAL_FIELDS.filter((f) => doc[f] === undefined)
  const hasLegacy = LEGACY_FIELDS.every((f) => doc[f] !== undefined)
  if (missingCanonical.length > 0 && (opts.canonical || !hasLegacy)) {
    for (const field of missingCanonical) {
      errors.push({
        path: field,
        message: opts.canonical
          ? "required on an item a writer creates"
          : "required (or carry the legacy id, name, type trio)",
        rule: opts.canonical ? "rule-1" : "schema",
      })
    }
  }

  // $defs.lifetime allOf: `until` needs `at`, `while` needs `anchor`.
  checkLifetime(doc.lifetime, "lifetime", errors)
  if (isPlainObject(doc.evidence)) {
    checkLifetime(doc.evidence.lifetime, "evidence.lifetime", errors)
  }

  // Section 2: on a memory/v1 item `kind` is one of the memory types.
  if (
    typeof doc.kind === "string" &&
    !(MEMORY_TYPES as readonly string[]).includes(doc.kind)
  ) {
    errors.push({
      path: "kind",
      message: `must be one of ${MEMORY_TYPES.join(", ")}`,
      rule: "section-2",
    })
  }

  // Rule 2: kind and type agree when both are present.
  if (doc.kind !== undefined && doc.type !== undefined && doc.kind !== doc.type) {
    errors.push({
      path: "kind",
      message: `must equal type ('${String(doc.type)}') when both are present`,
      rule: "rule-2",
    })
  }

  // Rule 4: an optional field with no value is omitted, never empty.
  const { body: _body, ...frontmatter } = doc
  for (const path of emptyValuePaths(frontmatter, [])) {
    if (errors.some((e) => e.path === path)) continue
    errors.push({ path, message: "empty value: omit the field instead", rule: "rule-4" })
  }

  // Rule 5: polarity only on feedback items.
  const type = doc.type ?? doc.kind
  if (doc.polarity !== undefined && type !== "feedback") {
    errors.push({
      path: "polarity",
      message: "only allowed on an item whose type is 'feedback'",
      rule: "rule-5",
    })
  }

  // Rule 8 (SHOULD): record where and when the claim was observed.
  const provenance = isPlainObject(doc.provenance) ? doc.provenance : {}
  for (const field of ["source", "at"] as const) {
    if (provenance[field] === undefined) {
      warnings.push({
        path: `provenance.${field}`,
        message: "should be recorded",
        rule: "rule-8",
      })
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

function checkLifetime(value: unknown, path: string, errors: MemoryIssue[]): void {
  if (!isPlainObject(value)) return
  checkUnknownKeys(value, LIFETIME_KEYS, path, errors)
  if (value.kind === "until" && value.at === undefined) {
    errors.push({ path: `${path}.at`, message: "required when kind is 'until'", rule: "schema" })
  }
  if (value.kind === "while" && value.anchor === undefined) {
    errors.push({
      path: `${path}.anchor`,
      message: "required when kind is 'while'",
      rule: "schema",
    })
  }
}

function checkUnknownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  path: string,
  errors: MemoryIssue[],
): void {
  for (const key of Object.keys(value)) {
    const keyPath = path ? `${path}.${key}` : key
    if (known.includes(key) || errors.some((e) => e.path === keyPath)) continue
    errors.push({ path: keyPath, message: "unknown field", rule: "schema" })
  }
}

/** Paths of empty strings and empty objects below the document root. */
function emptyValuePaths(value: unknown, path: string[]): string[] {
  if (value === "") return [path.join(".")]
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => emptyValuePaths(v, [...path, String(i)]))
  }
  if (!isPlainObject(value)) return []
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  if (entries.length === 0 && path.length > 0) return [path.join(".")]
  return entries.flatMap(([k, v]) => emptyValuePaths(v, [...path, k]))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

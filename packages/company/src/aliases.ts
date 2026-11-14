/**
 * AIP-6 §Frontmatter aliases: `doctype`/`kind` and `id`/`slug`.
 *
 * Writers emit `doctype` and `id`. Readers accept `kind` as `doctype` and
 * `slug` as `id`, with no removal date. A file that carries an alias and its
 * canonical field with different values is refused with `alias_conflict`: the
 * JSON Schema cannot compare two values, so the host does it here.
 */

export class CompanyAliasError extends Error {
  readonly code = "alias_conflict" as const
  constructor(message: string) {
    super(message)
    this.name = "CompanyAliasError"
  }
}

const PAIRS = [
  ["doctype", "kind"],
  ["id", "slug"],
] as const

/**
 * Resolve the aliases of a raw frontmatter object. Returns a copy that carries
 * only the canonical names; `context` prefixes the error of a conflict.
 */
export function canonicalizeCompany(
  raw: Record<string, unknown>,
  context: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  for (const [canonical, alias] of PAIRS) {
    const a = out[canonical]
    const b = out[alias]
    if (a !== undefined && b !== undefined && a !== b) {
      throw new CompanyAliasError(
        `${context}: alias_conflict: ${canonical}=${JSON.stringify(a)} and ${alias}=${JSON.stringify(b)} differ; they are one field`,
      )
    }
    if (a === undefined && b !== undefined) out[canonical] = b
    delete out[alias]
  }
  return out
}

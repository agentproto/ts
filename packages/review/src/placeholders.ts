/**
 * `{name}` placeholder substitution for command checks' `run` lines.
 *
 * The mechanism is generic: a placeholder is `{identifier}` (identifier =
 * `[A-Za-z][A-Za-z0-9_-]*`) and is replaced by `vars[identifier]`. The host
 * decides which variables exist; the compiler always provides
 *
 *   - `{base}` — the range's base sha
 *   - `{head}` — the range's frozen head sha (lanes only — prepare steps run
 *                BEFORE the range is frozen, so `{head}` isn't bound there)
 *
 * and the daemon host adds `{changed}` — a turbo `--filter` selector for the
 * packages changed in the range (`...[<base>]`, see `review-tools.ts`).
 *
 * What is NOT a placeholder, so shell syntax passes through untouched:
 * `${VAR}` (a `$` right before the brace), brace expansion (`{a,b}`), and
 * anything else that isn't a bare identifier in braces. `{{name}}` escapes a
 * literal `{name}`.
 *
 * An identifier placeholder with no bound value is an error, never a silent
 * literal — `turbo run build --filter={changed}` running with the literal
 * `{changed}` would build nothing and pass.
 */

const PLACEHOLDER_RE = /\{\{([A-Za-z][A-Za-z0-9_-]*)\}\}|(?<!\$)\{([A-Za-z][A-Za-z0-9_-]*)\}/g

export class ReviewPlaceholderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReviewPlaceholderError"
  }
}

/** Placeholder names referenced by `template` (escaped `{{x}}` excluded). */
export function listPlaceholders(template: string): string[] {
  const names = new Set<string>()
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    if (m[2] !== undefined) names.add(m[2])
  }
  return [...names]
}

/** Substitute `{name}` placeholders from `vars`. Throws
 *  {@link ReviewPlaceholderError} on a placeholder with no value. */
export function substitutePlaceholders(
  template: string,
  vars: Readonly<Record<string, string>>,
  label = "command",
): string {
  return template.replace(PLACEHOLDER_RE, (whole, escaped: string | undefined, name: string | undefined) => {
    if (escaped !== undefined) return `{${escaped}}`
    const value = vars[name!]
    if (value === undefined) {
      const known = Object.keys(vars)
      throw new ReviewPlaceholderError(
        `${label}: placeholder '${whole}' has no value` +
          (known.length > 0 ? ` — bound placeholders: ${known.map((k) => `{${k}}`).join(", ")}` : ""),
      )
    }
    return value
  })
}

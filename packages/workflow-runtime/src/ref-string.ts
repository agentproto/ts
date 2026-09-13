/**
 * The shared string-ref resolver (AIP-16 ref grammar): ONE implementation for
 * every field that accepts "a string that may START with a `$…` run-time
 * reference plus trailing literal text" — `harness.knowledge[]` selector
 * strings, a `kind:"gate"` step's `args[]`, and its `cwd`.
 */

import { resolveRefPrefixed } from "./compile-workflow.js"
import type { Bindings } from "./types.js"

/**
 * Resolve one string against the run bindings. Rule: refs are only
 * recognized at the START of the string. The leading reference token — the
 * shared AIP-16 prefix grammar in {@link resolveRefPrefixed} (it stops at
 * the first `/`, e.g. `$input.bookDir` in `$input.bookDir/knowledge`) — is
 * resolved against the bindings and `String()`-ed; the remainder of the
 * string is appended verbatim. A string that is exactly a ref resolves to
 * that value's string form. `$$` escapes to a literal `$`. A string without
 * a leading ref passes through untouched — unless `onUnmatched` is
 * `"error"` and the string starts with a `$` that does not open a known ref
 * token, in which case it throws (the gate `args`/`cwd` behavior: a literal
 * `$foo` handed to a subprocess is always a footgun, never intended). An
 * unresolvable or malformed ref throws naming the step and `field`
 * (e.g. `harness.knowledge[0].workspace`, `args[2]`, `cwd`).
 */
export function resolveRefString(
  stepId: string,
  field: string,
  value: string,
  b: Bindings,
  onUnmatched: "passthrough" | "error" = "passthrough",
): string {
  if (value.startsWith("$$")) return value.slice(1)
  let hit: ReturnType<typeof resolveRefPrefixed>
  try {
    hit = resolveRefPrefixed(value, b)
  } catch (err) {
    throw new Error(
      `step '${stepId}': ${field} '${value}' is not a valid reference — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!hit) {
    if (onUnmatched === "error" && value.startsWith("$")) {
      throw new Error(
        `step '${stepId}': ${field} '${value}' is not a valid reference — a leading '$' must open a $input/$item/$steps.<id>/$index reference ('$$' escapes a literal '$')`,
      )
    }
    return value
  }
  const token = value.slice(0, value.length - hit.rest.length)
  if (hit.resolved === undefined) {
    throw new Error(
      `step '${stepId}': ${field} '${token}' resolves to nothing — the referenced field does not exist`,
    )
  }
  return String(hit.resolved) + hit.rest
}

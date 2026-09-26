/**
 * The `@agentproto/config` deep-link fragment grammar (plan §3.4):
 *
 *   #<section>[/<id>[/<sub>]]
 *   section := wallets | harnesses | models | defaults | remote | advanced
 *   id      := encodeURIComponent(profileId | adapterSlug | modelRef | configKey | "pairing")
 *
 * Written in plain ES5-safe syntax (`var`/`function`, no arrows, no
 * destructuring) and inlined verbatim into the panel's `<script>` via
 * `parseConfigFragment.toString()` / `buildConfigFragment.toString()`
 * (see `ui.ts`) — this is the ONE copy of the parser, tested directly here
 * and run unmodified in the browser. Every free variable it needs (the
 * section list) is declared INSIDE the function body so the embedded
 * source has no dependency on this module's closure.
 */

export const CONFIG_SECTIONS = ["wallets", "harnesses", "models", "defaults", "remote", "advanced"] as const

export type ConfigSection = (typeof CONFIG_SECTIONS)[number]

export interface ParsedConfigFragment {
  section: ConfigSection
  id?: string
  sub?: string
}

/** Unknown section -> first section (`wallets`). Unknown/absent id or sub is
 *  simply omitted — never guessed, never a blank crash. A malformed
 *  percent-encoding in `id`/`sub` falls back to the raw segment rather than
 *  throwing. */
export function parseConfigFragment(hash: string): ParsedConfigFragment {
  var SECTIONS = ["wallets", "harnesses", "models", "defaults", "remote", "advanced"]
  var raw = String(hash || "").replace(/^#/, "")
  var parts = raw.split("/").filter(function (p) {
    return p.length > 0
  })
  var sectionRaw = parts[0] || ""
  var section = SECTIONS.indexOf(sectionRaw) !== -1 ? sectionRaw : SECTIONS[0]!
  var result: { section: string; id?: string; sub?: string } = { section: section }
  var idPart = parts[1]
  if (idPart !== undefined) {
    try {
      result.id = decodeURIComponent(idPart)
    } catch (e) {
      result.id = idPart
    }
  }
  var subPart = parts[2]
  if (subPart !== undefined) {
    try {
      result.sub = decodeURIComponent(subPart)
    } catch (e) {
      result.sub = subPart
    }
  }
  return result as ParsedConfigFragment
}

/** Inverse of {@link parseConfigFragment} — builds the hash string (with the
 *  leading `#`) the panel writes back to `location.hash` on navigation. */
export function buildConfigFragment(section: string, id?: string, sub?: string): string {
  var out = "#" + section
  if (id !== undefined && id !== null && id !== "") out += "/" + encodeURIComponent(id)
  if (sub !== undefined && sub !== null && sub !== "") out += "/" + encodeURIComponent(sub)
  return out
}

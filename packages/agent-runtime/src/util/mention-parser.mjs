/**
 * Canonical @-mention parser.
 *
 * Lives as raw JavaScript (no types) because it's consumed in two
 * places that don't share a build:
 *
 *   1. The kernel imports `textContainsMention` from this file as a
 *      normal ESM module (the dispatcher in `adapters/dispatcher-mention.ts`).
 *
 *   2. Runtime profiles inline this file's source into Claude Code
 *      hooks at profile-build time, because `.claude/` has no
 *      module-resolution at hook-execution time. The build script
 *      reads this file as text and stamps it into the hook template.
 *
 * Two cases:
 *   1. Literal `@<name>` substring (case-sensitive, full name).
 *   2. For multi-word names, also `@<firstName>` with non-word
 *      boundary (case-insensitive).
 *
 * Edit here only — both consumers stay in sync via build pipelines.
 */

/** @param {string} text @param {string} name @returns {boolean} */
export function textContainsMention(text, name) {
  if (text.includes(`@${name}`)) return true
  if (name.includes(" ")) {
    const firstName = name.split(" ")[0]?.trim()
    if (!firstName) return false
    const regex = new RegExp(`@${firstName}(?!\\w)`, "i")
    return regex.test(text)
  }
  return false
}

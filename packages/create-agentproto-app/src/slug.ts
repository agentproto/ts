/**
 * Slug/name derivation for a scaffolded app. The target directory's basename
 * is the single source of truth for `__APP_SLUG__` (used in filesystem-safe
 * paths like `.agentproto/agents/<slug>-assistant/`); `--id`/`--name` only
 * override the human-facing `__APP_ID__`/`__APP_NAME__` tokens.
 */

/** Lowercase, hyphenate, and strip anything that isn't `[a-z0-9-]`. */
export function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "app"
}

/** Title-case a hyphenated slug into a default display name. */
export function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter((word) => word.length > 0)
    .map(capitalize)
    .join(" ")
}

function capitalize(word: string): string {
  const [first, ...rest] = word
  return first === undefined ? word : first.toUpperCase() + rest.join("")
}

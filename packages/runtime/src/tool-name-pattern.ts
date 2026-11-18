/**
 * Tool-name matching for the `/mcp/imported/<id>` mount's `?allowTools=` /
 * `?denyTools=` lists. A pattern is an exact tool name, or contains `*`
 * (matches any run of characters, e.g. `list_*`, `get_*`, `*_issue`).
 * Nothing else is special. Deliberately scoped to the imported-MCP mount:
 * the plain `/mcp` gateway keeps exact-name `Set` semantics.
 */

const MAX_COMPILED = 256
const compiled = new Map<string, RegExp>()

function toRegExp(pattern: string): RegExp {
  let re = compiled.get(pattern)
  if (!re) {
    if (compiled.size >= MAX_COMPILED) compiled.clear() // bound the cache; patterns come from query params
    re = new RegExp(
      `^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
    )
    compiled.set(pattern, re)
  }
  return re
}

/** True when `name` equals `pattern`, or matches it with `*` as wildcard. */
export function toolNameMatches(pattern: string, name: string): boolean {
  return pattern.includes("*") ? toRegExp(pattern).test(name) : pattern === name
}

/** True when `name` matches any pattern in `patterns`. */
export function matchesAnyToolPattern(patterns: ReadonlySet<string>, name: string): boolean {
  if (patterns.has(name)) return true
  for (const p of patterns) if (toolNameMatches(p, name)) return true
  return false
}

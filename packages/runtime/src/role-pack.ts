/**
 * Pack-carried role definitions — parses a `ROLE.md` file (frontmatter +
 * markdown body) into a `RoleProfile`. Pure: takes a string, returns a
 * value or throws. No fs here — see `role-registry.ts` for the on-disk /
 * adapter-package discovery that hands this function raw file contents.
 *
 * Frontmatter is a flat `key: value` block between `---` fences, the same
 * trivial format `conversations.ts`'s `parseFrontmatter` uses (no yaml
 * dep) extended with dotted keys (`toolPolicy.delegation`) and
 * comma-separated list values (`skills: a, b, c`). The body (everything
 * after the closing fence) becomes `disposition` verbatim.
 */

import type { DelegationPolicy, RoleProfile } from "./role.js"

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/

function parseFields(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const colon = line.indexOf(":")
    if (colon < 1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (!key) continue
    out[key] = value
  }
  return out
}

function isDelegationPolicy(value: string | undefined): value is DelegationPolicy {
  return value === "allow" || value === "deny"
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined || value === "") return undefined
  const stripped = value.replace(/^\[/, "").replace(/\]$/, "")
  const items = stripped
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

/**
 * Parse a `ROLE.md` document into a `RoleProfile`.
 *
 * @throws when the frontmatter fence is missing, `role` (the name) is
 * absent, `level` is missing/not a finite number, or
 * `toolPolicy.delegation` is missing/not `"allow"`/`"deny"` — a
 * malformed pack must fail loudly rather than silently install a
 * half-specified role.
 */
export function parseRolePack(md: string): RoleProfile {
  const match = md.match(FRONTMATTER_RE)
  if (!match) {
    throw new Error(
      "parseRolePack: missing frontmatter — expected a '---' fenced header at the top of ROLE.md",
    )
  }
  const fields = parseFields(match[1] ?? "")
  const disposition = md.slice(match[0].length).trim()

  const name = fields.role
  if (!name) {
    throw new Error("parseRolePack: missing 'role' field in frontmatter")
  }

  const level = fields.level !== undefined ? Number(fields.level) : NaN
  if (!Number.isFinite(level)) {
    throw new Error(
      `parseRolePack: missing or invalid 'level' field for role "${name}" (expected a number)`,
    )
  }

  const delegation = fields["toolPolicy.delegation"]
  if (!isDelegationPolicy(delegation)) {
    throw new Error(
      `parseRolePack: missing or invalid 'toolPolicy.delegation' field for role "${name}" ` +
        '(expected "allow" or "deny")',
    )
  }

  const skills = parseList(fields.skills)
  const spawnableRoles = parseList(fields.spawnableRoles)

  const profile: RoleProfile = {
    name,
    disposition,
    toolPolicy: { delegation },
    level,
    ...(skills ? { skills } : {}),
    ...(spawnableRoles ? { spawnableRoles } : {}),
  }
  return profile
}

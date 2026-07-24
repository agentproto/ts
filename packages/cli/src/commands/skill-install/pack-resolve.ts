/**
 * Skill pack resolution + listing.
 *
 * A "pack" is any directory shaped `skills/<slug>/SKILL.md` — the layout
 * `listSkills` / `parseSkillFrontmatter` below assume. `resolveSkillPackDir`
 * accepts:
 *   - a path (absolute or containing "/", or one that exists on disk) —
 *     used verbatim (home-expanded).
 *   - a bare name — searched in order: `~/.agentproto/packs/<name>/`,
 *     `<repoRoot>/.skills/<name>/`, then the npm dual-naming convention
 *     (`@agentproto/skill-pack-<name>` / `@<scope>/agentproto-skill-pack-<name>`).
 *   - omitted — the legacy default: glob `.skills/agentproto-plugin-v*`
 *     from the repo root, picking the highest semver. UNCHANGED behavior —
 *     but note that `.skills/` in THIS repo is no longer committed (it used
 *     to be, hand-copied on every bump; see packages/skill-pack-*).
 *
 * With `allowFetch` (the CLI turns it on; direct callers stay purely local),
 * a final step FETCHES the pack from the network when nothing local matches —
 * npm (`@agentproto/skill-pack-<name>@<ver|latest>`) or a github ref — and
 * materializes it into `~/.agentproto/packs/<name>@<ver>/`, returning that
 * dir (see ./fetch-pack.ts). So `agentproto onboard` / `install skill/<name>`
 * resolve the published pack out of the box with no `--pack`.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import matter from "gray-matter"
import { pathExists } from "./shared.js"
import { fetchPack, parsePackSpec } from "./fetch-pack.js"
import type { SkillInfo } from "./types.js"

// ── ~ / env expansion ────────────────────────────────────────────────────

/** Expand a leading `~` and any `$VAR` / `${VAR}` references against the
 *  current environment. Unknown vars are left untouched (not blanked). */
export function expandHome(p: string): string {
  let out = p
  if (out === "~") {
    out = homedir()
  } else if (out.startsWith("~/")) {
    out = join(homedir(), out.slice(2))
  }
  return out.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, braced: string | undefined, bare: string | undefined) => {
    const key = braced ?? bare
    if (!key) return match
    const val = process.env[key]
    return val !== undefined ? val : match
  })
}

// ── repo root ────────────────────────────────────────────────────────────

/** Find the repo root by walking up from this source file. */
export async function findRepoRoot(): Promise<string | null> {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, ".skills")
    try {
      const s = await stat(candidate)
      if (s.isDirectory()) return dir
    } catch {
      // not found here
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// ── legacy default pack (unchanged) ──────────────────────────────────────

/**
 * Glob .skills/agentproto-plugin-v* from the repo root, pick the
 * highest semver. Returns the absolute path to the pack dir. This is
 * the behavior used when no `--pack` is given — kept verbatim for
 * back-compat.
 */
async function resolveLegacyPluginPack(): Promise<string | null> {
  const root = await findRepoRoot()
  if (!root) return null

  const skillsDir = join(root, ".skills")
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch {
    return null
  }

  const prefix = "agentproto-plugin-v"
  const candidates: { name: string; version: string; path: string }[] = []

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const version = entry.slice(prefix.length)
    // Basic semver-like check: digits.digits.digits(-prerelease)?
    if (!/^\d+\.\d+\.\d+/.test(version)) continue
    const fullPath = join(skillsDir, entry)
    try {
      const s = await stat(fullPath)
      if (s.isDirectory()) {
        candidates.push({ name: entry, version, path: fullPath })
      }
    } catch {
      // skip
    }
  }

  if (candidates.length === 0) return null

  // Sort by semver descending, pick highest
  candidates.sort((a, b) => compareSemver(b.version, a.version))
  const selected = candidates[0]
  if (!selected) return null
  return selected.path
}

/** Simple semver comparator for major.minor.patch(-prerelease) strings. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/)
    if (!m) return null
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  return pa.patch - pb.patch
}

// ── npm dual-convention lookup for named packs ───────────────────────────

/** Walk up from `start` collecting every `node_modules` dir reachable
 *  (mirrors the walker in `@agentproto/provider-kit`'s discover.ts, kept
 *  local here since this convention is "skill-pack-<name>", not
 *  "adapter-<slug>"). */
async function collectNodeModulesRoots(start: string): Promise<string[]> {
  const seen = new Set<string>()
  const roots: string[] = []
  let cur = start
  for (let i = 0; i < 20; i++) {
    if (seen.has(cur)) break
    seen.add(cur)
    const candidate = join(cur, "node_modules")
    if (await pathExists(candidate)) roots.push(candidate)
    const pnpmCandidate = join(cur, "node_modules", ".pnpm", "node_modules")
    if (await pathExists(pnpmCandidate)) roots.push(pnpmCandidate)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return roots
}

/**
 * Search installed node_modules for a skill pack named `name`, trying
 * both naming conventions:
 *   - first-party:  `@agentproto/skill-pack-<name>`
 *   - third-party:  `@<scope>/agentproto-skill-pack-<name>`
 */
async function findSkillPackInNodeModules(name: string): Promise<string | null> {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()]
  const roots: string[] = []
  for (const start of starts) {
    for (const root of await collectNodeModulesRoots(start)) {
      if (!roots.includes(root)) roots.push(root)
    }
  }

  for (const root of roots) {
    const firstParty = join(root, "@agentproto", `skill-pack-${name}`)
    if (await pathExists(firstParty)) return firstParty

    let scopes: string[]
    try {
      scopes = await readdir(root)
    } catch {
      continue
    }
    for (const scope of scopes) {
      if (!scope.startsWith("@") || scope === "@agentproto") continue
      const candidate = join(root, scope, `agentproto-skill-pack-${name}`)
      if (await pathExists(candidate)) return candidate
    }
  }
  return null
}

// ── public resolver ───────────────────────────────────────────────────────

export interface ResolvePackOpts {
  /**
   * Permit a NETWORK fetch (npm / github) as the final resolution step when
   * nothing local matches. OFF by default so direct callers (and the unit
   * tests) keep the original purely-local behavior — the CLI turns it on.
   */
  allowFetch?: boolean
  /** Bypass the `packs/<name>@<ver>` cache and re-fetch from the source. */
  refresh?: boolean
}

/**
 * Resolve a pack directory. Modes (path / bare name / omitted) are unchanged;
 * with `allowFetch`, a final fetch step materializes the pack into the
 * central store `~/.agentproto/packs/<name>@<ver>/` and returns that dir.
 *
 * Resolution order:
 *   1. omitted   → legacy `.skills/agentproto-plugin-v*` → node_modules
 *      `@agentproto/skill-pack-agentproto` → (fetch) npm `…@latest`.
 *   2. path      → used verbatim (home-expanded), unchanged.
 *   3. bare name → central `packs/<name>` pointer → repo `.skills/<name>` →
 *      node_modules → (fetch) per the `--pack` grammar (npm / github).
 * `refresh` forces the fetch even when a cache dir/pointer already exists.
 */
export async function resolveSkillPackDir(
  pack?: string,
  opts: ResolvePackOpts = {},
): Promise<string | null> {
  const { allowFetch = false, refresh = false } = opts

  if (pack === undefined) {
    const legacy = await resolveLegacyPluginPack()
    if (legacy) return legacy
    // Prefer an already-present node_modules copy before the network.
    const nm = await findSkillPackInNodeModules("agentproto")
    if (nm) return nm
    if (allowFetch) return fetchPack(parsePackSpec(undefined), { refresh })
    return null
  }

  const expanded = expandHome(pack)
  // A `github:`/`npm:` scheme spec contains '/' (owner/repo) but is NEVER a
  // filesystem path — parse it as a spec, don't short-circuit to verbatim.
  const isSchemeSpec = pack.startsWith("github:") || pack.startsWith("npm:")
  if (!isSchemeSpec) {
    const looksLikePath = expanded.includes("/")
    if (looksLikePath || (await pathExists(expanded))) {
      return expanded
    }
  }

  const spec = parsePackSpec(pack)
  const packsDir = join(homedir(), ".agentproto", "packs")

  if (spec.kind === "local") {
    return expanded
  }

  // A PINNED npm version or a github ref names a SPECIFIC source — don't let
  // an unrelated bare-name copy in node_modules/.skills satisfy it. Check
  // only that source's own cache dir, then fetch.
  if (spec.kind === "github") {
    const cached = join(packsDir, `${spec.name}@${spec.ref.replace(/[/\\]/g, "-")}`)
    if (!refresh && (await pathExists(cached))) return cached
    return allowFetch ? fetchPack(spec, { refresh }) : null
  }
  if (spec.version !== "latest") {
    const pinned = join(packsDir, `${spec.name}@${spec.version}`)
    if (!refresh && (await pathExists(pinned))) return pinned
    return allowFetch ? fetchPack(spec, { refresh }) : null
  }

  // bare name / latest / omitted default: prefer a local copy — central
  // `packs/<name>` pointer, repo `.skills/<name>`, then node_modules — and
  // only hit the network when nothing local matches. `--refresh` skips the
  // local layers so a re-fetch actually re-fetches.
  if (!refresh) {
    const central = join(packsDir, spec.name)
    if (await pathExists(central)) return central

    const root = await findRepoRoot()
    if (root) {
      const local = join(root, ".skills", spec.name)
      if (await pathExists(local)) return local
    }

    const nm = await findSkillPackInNodeModules(spec.name)
    if (nm) return nm
  }

  return allowFetch ? fetchPack(spec, { refresh }) : null
}

// ── skill listing / parsing ────────────────────────────────────────────

export async function listSkills(packDir: string): Promise<SkillInfo[]> {
  const skillsDir = join(packDir, "skills")
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch {
    return []
  }

  const results: SkillInfo[] = []
  for (const entry of entries) {
    const skillDir = join(skillsDir, entry)
    try {
      const st = await stat(skillDir)
      if (!st.isDirectory()) continue
    } catch {
      continue
    }
    try {
      const fm = await parseSkillFrontmatter(skillDir)
      results.push(fm)
    } catch {
      // Skip skills whose SKILL.md can't be parsed
    }
  }
  // Sort by name for stable output
  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

/**
 * Parse the YAML frontmatter from a skill's SKILL.md.
 * Returns the skill name and description.
 */
export async function parseSkillFrontmatter(skillDir: string): Promise<SkillInfo> {
  const mdPath = join(skillDir, "SKILL.md")
  const raw = await readFile(mdPath, "utf8")
  const parsed = matter(raw)

  if (Object.keys(parsed.data).length === 0) {
    throw new Error(`parseSkillFrontmatter: missing frontmatter in ${mdPath}`)
  }

  const front: Record<string, unknown> = parsed.data
  const name = typeof front.name === "string" ? front.name : null
  const desc = typeof front.description === "string" ? front.description : ""

  if (!name) {
    throw new Error(
      `parseSkillFrontmatter: missing or invalid 'name' field in ${mdPath}`,
    )
  }

  return { name, description: desc, dir: skillDir }
}

/**
 * On-disk adapter discovery — the shared node_modules walker used by every
 * adapter family (agent-CLI, tunnel, …) so none of them reimplements it.
 *
 * Three naming conventions are supported so anyone can publish a provider
 * (AIP-70 renamed "adapter" to "harness"; the driven binary is a harness, so
 * under the `harness-` spelling both spellings are accepted additively until
 * any package rename):
 *   - first-party:  `@agentproto/adapter-<slug>` and `@agentproto/harness-<slug>`
 *   - third-party:  `@<scope>/agentproto-adapter-<slug>` and
 *                   `@<scope>/agentproto-harness-<slug>`
 *
 * Precedence on a slug collision:
 *   1. first-party `@agentproto/...` beats any third-party scope (as before)
 *   2. within the same tier, the canonical `harness-` spelling beats
 *      `adapter-` — so `@agentproto/harness-dup` wins over
 *      `@agentproto/adapter-dup`
 * The bare `@agentproto/harness` package (no dash suffix) is NOT an adapter
 * and is never matched.
 *
 * Discovery reads disk on every call and never throws on a bad/missing dir —
 * partial discovery beats failing a whole listing on one broken package.
 * Cache at the caller layer if you list often.
 */

import { promises as fs } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve as resolvePath } from "node:path"

/** An adapter package found on disk — not yet imported. */
export interface DiscoveredAdapter {
  /**
   * lower-kebab slug (the part after `adapter-` / `harness-` for first-party
   * packages, after `agentproto-adapter-` / `agentproto-harness-` for
   * third-party ones).
   */
  readonly slug: string
  /** Full npm package name to `import()`. */
  readonly packageName: string
}

/**
 * Direct-dir-entry match used by the `@agentproto` scope walkers (cli
 * `listInstalledAdapters` + `discoverExtraHandles`): returns the slug for an
 * `adapter-<slug>` or canonical `harness-<slug>` directory entry, null
 * otherwise. The bare `harness` package (no dash suffix) is NOT a match.
 */
export function adapterSlugFromDirEntry(entry: string): string | null {
  if (entry.startsWith("adapter-")) return entry.slice("adapter-".length)
  if (entry.startsWith("harness-")) return entry.slice("harness-".length)
  return null
}

/** Whether a package name uses the canonical AIP-70 `harness-` spelling. */
export function isHarnessPackageName(packageName: string): boolean {
  const leaf = packageName.slice(packageName.lastIndexOf("/") + 1)
  return (
    leaf.startsWith("harness-") || leaf.startsWith("agentproto-harness-")
  )
}

/**
 * Walk up from `start` collecting every `node_modules/@agentproto` directory
 * reachable (pnpm + global + nvm hoisting can produce more than one). Kept for
 * families that only use the first-party `@agentproto/adapter-<slug>`
 * convention.
 */
export async function collectAgentprotoNamespaceRoots(
  start?: string
): Promise<string[]> {
  const seen = new Set<string>()
  const roots: string[] = []
  const candidatesAt = (dir: string): string[] => [
    resolvePath(dir, "node_modules", "@agentproto"),
    resolvePath(dir, "node_modules", ".pnpm", "node_modules", "@agentproto"),
  ]

  async function walkUp(from: string): Promise<void> {
    let cur = from
    for (let depth = 0; depth < 20; depth++) {
      if (seen.has(cur)) break
      seen.add(cur)
      for (const candidate of candidatesAt(cur)) {
        try {
          const s = await fs.stat(candidate)
          if (s.isDirectory() && !roots.includes(candidate)) roots.push(candidate)
        } catch {
          /* not present */
        }
      }
      const parent = resolvePath(cur, "..")
      if (parent === cur) break
      cur = parent
    }
  }

  await walkUp(start ?? process.cwd())
  // Also walk from this module's location so pnpm-linked packages are found
  // regardless of cwd (works from dist .mjs or ts-node).
  try {
    await walkUp(dirname(fileURLToPath(import.meta.url)))
  } catch {
    /* import.meta not available in this context */
  }

  return roots
}

/**
 * Walk up collecting every `node_modules` directory reachable (incl. the pnpm
 * virtual store) so we can scan ALL scopes — needed to find third-party
 * `@<scope>/agentproto-adapter-<slug>` packages.
 */
async function collectNodeModulesRoots(start?: string): Promise<string[]> {
  const seen = new Set<string>()
  const roots: string[] = []
  const candidatesAt = (dir: string): string[] => [
    resolvePath(dir, "node_modules"),
    resolvePath(dir, "node_modules", ".pnpm", "node_modules"),
  ]

  async function walkUp(from: string): Promise<void> {
    let cur = from
    for (let depth = 0; depth < 20; depth++) {
      if (seen.has(cur)) break
      seen.add(cur)
      for (const candidate of candidatesAt(cur)) {
        try {
          const s = await fs.stat(candidate)
          if (s.isDirectory() && !roots.includes(candidate)) roots.push(candidate)
        } catch {
          /* not present */
        }
      }
      const parent = resolvePath(cur, "..")
      if (parent === cur) break
      cur = parent
    }
  }

  await walkUp(start ?? process.cwd())
  try {
    await walkUp(dirname(fileURLToPath(import.meta.url)))
  } catch {
    /* import.meta not available in this context */
  }

  return roots
}

/**
 * Discover adapter packages on disk across BOTH naming conventions (adapter-
 * and harness-prefixed, first- and third-party). Deduped by slug; on a
 * collision the canonical `harness-` spelling wins within a tier, and
 * first-party `@agentproto` still beats third-party.
 */
export async function discoverAdapterPackages(opts?: {
  start?: string
}): Promise<DiscoveredAdapter[]> {
  const roots = await collectNodeModulesRoots(opts?.start)
  const bySlug = new Map<string, DiscoveredAdapter>()

  for (const root of roots) {
    let scopes: string[] = []
    try {
      scopes = await fs.readdir(root)
    } catch {
      continue
    }
    for (const scope of scopes) {
      if (!scope.startsWith("@")) continue
      const scopeDir = resolvePath(root, scope)
      let entries: string[] = []
      try {
        entries = await fs.readdir(scopeDir)
      } catch {
        continue
      }
      // Canonical harness- spelling must win over adapter- even when it
      // lexicographically sorts later, so scan harness- first.
      const ranked = [...entries].sort(
        (a, b) => (a.startsWith("harness-") ? 0 : 1) - (b.startsWith("harness-") ? 0 : 1)
      )
      for (const entry of ranked) {
        let slug: string | null = null
        let packageName: string | null = null
        if (scope === "@agentproto" && adapterSlugFromDirEntry(entry) !== null) {
          slug = adapterSlugFromDirEntry(entry)
          packageName = `@agentproto/${entry}`
        } else if (entry.startsWith("agentproto-adapter-")) {
          slug = entry.slice("agentproto-adapter-".length)
          packageName = `${scope}/${entry}`
        } else if (entry.startsWith("agentproto-harness-")) {
          slug = entry.slice("agentproto-harness-".length)
          packageName = `${scope}/${entry}`
        }
        if (!slug || !packageName) continue
        const existing = bySlug.get(slug)
        // Precedence: canonical harness- beats adapter- within a tier;
        // first-party @agentproto still wins over third-party.
        if (!existing) {
          bySlug.set(slug, { slug, packageName })
          continue
        }
        const existingIsFirstParty =
          existing.packageName.startsWith("@agentproto/")
        const candidateIsFirstParty = packageName.startsWith("@agentproto/")
        if (existingIsFirstParty && !candidateIsFirstParty) {
          continue
        }
        if (!existingIsFirstParty && candidateIsFirstParty) {
          bySlug.set(slug, { slug, packageName })
          continue
        }
        // Same tier: canonical harness- wins over adapter-
        if (
          isHarnessPackageName(packageName) &&
          !isHarnessPackageName(existing.packageName)
        ) {
          bySlug.set(slug, { slug, packageName })
        }
      }
    }
  }

  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug))
}

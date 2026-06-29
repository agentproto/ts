/**
 * On-disk adapter discovery — the shared node_modules walker used by every
 * adapter family (agent-CLI, tunnel, …) so none of them reimplements it.
 *
 * Two naming conventions are supported so anyone can publish a provider:
 *   - first-party:  `@agentproto/adapter-<slug>`
 *   - third-party:  `@<scope>/agentproto-adapter-<slug>`
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
  /** lower-kebab slug (the part after `adapter-` / `agentproto-adapter-`). */
  readonly slug: string
  /** Full npm package name to `import()`. */
  readonly packageName: string
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
 * Discover adapter packages on disk across BOTH naming conventions. Deduped by
 * slug; on a collision the first-party `@agentproto/adapter-<slug>` wins.
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
      for (const entry of entries) {
        let slug: string | null = null
        let packageName: string | null = null
        if (scope === "@agentproto" && entry.startsWith("adapter-")) {
          slug = entry.slice("adapter-".length)
          packageName = `@agentproto/${entry}`
        } else if (entry.startsWith("agentproto-adapter-")) {
          slug = entry.slice("agentproto-adapter-".length)
          packageName = `${scope}/${entry}`
        }
        if (!slug || !packageName) continue
        const existing = bySlug.get(slug)
        // first-party @agentproto wins on conflict
        if (
          !existing ||
          (scope === "@agentproto" &&
            !existing.packageName.startsWith("@agentproto/"))
        ) {
          bySlug.set(slug, { slug, packageName })
        }
      }
    }
  }

  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug))
}

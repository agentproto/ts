import { readFileSync, realpathSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"

type RuntimeManifest = {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** Resolve Node's installed package links without requiring package.json to be exported. */
function resolveDependency(from: string, name: string): string | undefined {
  if (!/^(?:@[a-z0-9_-][a-z0-9._-]*\/)?[a-z0-9_-][a-z0-9._-]*$/i.test(name)) return

  let dir = from
  for (;;) {
    try {
      return realpathSync(join(dir, "node_modules", name))
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return
      dir = parent
    }
  }
}

/**
 * Seatbelt must read the adapter's JavaScript and its production dependencies
 * even when the app boundary hides the enclosing monorepo. A workspace link
 * receives only its manifest and built code, while an installed dependency
 * may also need assets or native libraries inside its package directory.
 * Discover these paths from the host-installed adapter, never the app's cwd.
 */
export function collectMastraConfinedReadPaths(adapterDir: string): string[] {
  const adapter = realpathSync(adapterDir)
  const workspaceRoot = join(adapter, "..", "..")
  const seen = new Set<string>()
  const paths = new Set<string>()

  function visit(dir: string): void {
    if (seen.has(dir)) return
    seen.add(dir)

    const manifestPath = join(dir, "package.json")
    let manifest: RuntimeManifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    } catch {
      // Optional dependencies may be absent in the installed package tree.
      return
    }
    if (!manifest || typeof manifest !== "object") return

    if (dir.split(sep).includes("node_modules")) {
      paths.add(dir)
    } else {
      const workspacePath = relative(workspaceRoot, dir)
      if (
        dir !== adapter &&
        (typeof manifest.name !== "string" ||
          !manifest.name.startsWith("@agentproto/") ||
          workspacePath === ".." ||
          workspacePath.startsWith(".." + sep))
      ) return
      paths.add(manifestPath)
      paths.add(join(dir, "dist"))
    }

    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    })) {
      const dependency = resolveDependency(dir, name)
      if (dependency) visit(dependency)
    }
  }

  visit(adapter)
  return [...paths]
}

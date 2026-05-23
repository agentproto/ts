/**
 * Manifest-based plugin wiring.
 *
 * Given a plugin package id, locate its plugin manifest, validate it,
 * and register every declared adapter (substrate, dispatcher,
 * executor, state store) with the runtime registry. The plugin
 * doesn't need to call register* itself — the manifest declares what
 * it provides, this loader handles the wiring.
 *
 * Discovery order, per plugin:
 *   1. `<package-root>/agentproto.json`
 *   2. `<package-root>/package.json` → `.agentproto` block
 *
 * Returns the manifest (so callers like `agentproto plugins show` can
 * print it) or `null` if neither location declares one. A `null`
 * return is not an error — the caller may fall back to side-effect
 * imports for legacy plugins.
 */

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import {
  PluginManifestSchema,
  type PluginManifest,
} from "./manifest.js"
import {
  registerDispatcher,
  registerExecutor,
  registerStateStore,
  registerSubstrate,
  type DispatcherFactory,
  type ExecutorFactory,
  type StateStoreFactory,
  type SubstrateFactory,
} from "./runtime.js"

/**
 * Load and register every adapter declared in a plugin's manifest.
 * Returns the manifest on success, `null` if the plugin doesn't ship
 * one (so the caller can fall back to side-effect import).
 */
export async function loadPluginFromManifest(
  pluginId: string
): Promise<PluginManifest | null> {
  const result = await readPluginManifest(pluginId)
  if (!result) return null
  const { manifest, packageRoot } = result

  for (const sub of manifest.substrates) {
    const factory = await importFactory<SubstrateFactory>(
      packageRoot,
      pluginId,
      sub.entry,
      sub.export
    )
    registerSubstrate(sub.kind, factory)
  }
  for (const dis of manifest.dispatchers) {
    const factory = await importFactory<DispatcherFactory>(
      packageRoot,
      pluginId,
      dis.entry,
      dis.export
    )
    registerDispatcher(dis.kind, factory)
  }
  for (const exe of manifest.executors) {
    const factory = await importFactory<ExecutorFactory>(
      packageRoot,
      pluginId,
      exe.entry,
      exe.export
    )
    registerExecutor(exe.kind, factory)
  }
  for (const st of manifest.stateStores) {
    const factory = await importFactory<StateStoreFactory>(
      packageRoot,
      pluginId,
      st.entry,
      st.export
    )
    registerStateStore(st.kind, factory)
  }

  return manifest
}

/**
 * Read + validate a plugin's manifest without registering anything.
 * Used by `agentproto plugins show` to introspect installed plugins.
 */
export async function readPluginManifest(
  pluginId: string
): Promise<{ manifest: PluginManifest; packageRoot: string } | null> {
  const packageJsonPath = resolvePluginPackageJson(pluginId)
  if (!packageJsonPath) return null

  const packageRoot = dirname(packageJsonPath)

  // 1. Try standalone agentproto.json first.
  const standalonePath = join(packageRoot, "agentproto.json")
  const standalone = await readJsonIfExists(standalonePath)
  if (standalone !== undefined) {
    return {
      manifest: PluginManifestSchema.parse(standalone),
      packageRoot,
    }
  }

  // 2. Fall back to package.json#agentproto.
  const pkgJson = (await readJsonIfExists(packageJsonPath)) as
    | { agentproto?: unknown }
    | undefined
  if (pkgJson && typeof pkgJson === "object" && pkgJson.agentproto) {
    return {
      manifest: PluginManifestSchema.parse(pkgJson.agentproto),
      packageRoot,
    }
  }

  return null
}

async function importFactory<TFactory>(
  packageRoot: string,
  pluginId: string,
  entry: string,
  exportName: string
): Promise<TFactory> {
  // Resolve the entry path relative to the package root. We dynamic-
  // import via file:// URL so an absolute path works without going
  // through Node's package resolver (which would need the export to
  // be declared in `exports`).
  const abs = entry.startsWith(".") ? join(packageRoot, entry) : entry
  const url = entry.startsWith(".") ? pathToFileURL(abs).href : entry
  const mod = (await import(url)) as Record<string, unknown>
  const exported = mod[exportName]
  if (typeof exported !== "function") {
    throw new Error(
      `agentproto plugin '${pluginId}': manifest entry '${entry}' has no callable export '${exportName}' (got ${typeof exported}).`
    )
  }
  return exported as TFactory
}

function resolvePluginPackageJson(pluginId: string): string | null {
  // Try the cli's own resolution first (global install + monorepo
  // workspace deps), then the user's cwd (locally-installed plugins).
  // `require.resolve` needs `createRequire` since we're an ESM bundle.
  const candidates = [
    import.meta.url,
    pathToFileURL(join(process.cwd(), "package.json")).href,
  ]
  for (const root of candidates) {
    try {
      return createRequire(root).resolve(`${pluginId}/package.json`)
    } catch {
      // try next root
    }
  }
  return null
}

async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    const raw = await readFile(path, "utf8")
    return JSON.parse(raw)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
}

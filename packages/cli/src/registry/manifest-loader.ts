/**
 * Manifest-based adapter wiring.
 *
 * Given an adapter package id, locate its adapter manifest, validate it,
 * and register every declared adapter (substrate, dispatcher,
 * executor, state store) with the runtime registry. The adapter
 * doesn't need to call register* itself — the manifest declares what
 * it provides, this loader handles the wiring.
 *
 * Discovery order, per adapter:
 *   1. `<package-root>/agentproto.json`
 *   2. `<package-root>/package.json` → `.agentproto` block
 *
 * Returns the manifest (so callers like `agentproto adapters show` can
 * print it) or `null` if neither location declares one. A `null`
 * return is not an error — the caller may fall back to side-effect
 * imports for legacy adapters.
 */

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import {
  AdapterManifestSchema,
  type AdapterManifest,
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
 * Load and register every adapter declared in an adapter's manifest.
 * Returns the manifest on success, `null` if the adapter doesn't ship
 * one (so the caller can fall back to side-effect import).
 */
export async function loadAdapterFromManifest(
  adapterId: string
): Promise<AdapterManifest | null> {
  const result = await readAdapterManifest(adapterId)
  if (!result) return null
  const { manifest, packageRoot } = result

  for (const sub of manifest.substrates) {
    const factory = await importFactory<SubstrateFactory>(
      packageRoot,
      adapterId,
      sub.entry,
      sub.export
    )
    registerSubstrate(sub.kind, factory)
  }
  for (const dis of manifest.dispatchers) {
    const factory = await importFactory<DispatcherFactory>(
      packageRoot,
      adapterId,
      dis.entry,
      dis.export
    )
    registerDispatcher(dis.kind, factory)
  }
  for (const exe of manifest.executors) {
    const factory = await importFactory<ExecutorFactory>(
      packageRoot,
      adapterId,
      exe.entry,
      exe.export
    )
    registerExecutor(exe.kind, factory)
  }
  for (const st of manifest.stateStores) {
    const factory = await importFactory<StateStoreFactory>(
      packageRoot,
      adapterId,
      st.entry,
      st.export
    )
    registerStateStore(st.kind, factory)
  }

  return manifest
}

/**
 * Read + validate an adapter's manifest without registering anything.
 * Used by `agentproto adapters show` to introspect installed adapters.
 */
export async function readAdapterManifest(
  adapterId: string
): Promise<{ manifest: AdapterManifest; packageRoot: string } | null> {
  const packageJsonPath = resolveAdapterPackageJson(adapterId)
  if (!packageJsonPath) return null

  const packageRoot = dirname(packageJsonPath)

  // 1. Try standalone agentproto.json first.
  const standalonePath = join(packageRoot, "agentproto.json")
  const standalone = await readJsonIfExists(standalonePath)
  if (standalone !== undefined) {
    return {
      manifest: AdapterManifestSchema.parse(standalone),
      packageRoot,
    }
  }

  // 2. Fall back to package.json#agentproto.
  const pkgJson = (await readJsonIfExists(packageJsonPath)) as
    | { agentproto?: unknown }
    | undefined
  if (pkgJson && typeof pkgJson === "object" && pkgJson.agentproto) {
    return {
      manifest: AdapterManifestSchema.parse(pkgJson.agentproto),
      packageRoot,
    }
  }

  return null
}

async function importFactory<TFactory>(
  packageRoot: string,
  adapterId: string,
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
      `agentproto adapter '${adapterId}': manifest entry '${entry}' has no callable export '${exportName}' (got ${typeof exported}).`
    )
  }
  return exported as TFactory
}

function resolveAdapterPackageJson(adapterId: string): string | null {
  // Try the cli's own resolution first (global install + monorepo
  // workspace deps), then the user's cwd (locally-installed adapters).
  // `require.resolve` needs `createRequire` since we're an ESM bundle.
  const candidates = [
    import.meta.url,
    pathToFileURL(join(process.cwd(), "package.json")).href,
  ]
  for (const root of candidates) {
    try {
      return createRequire(root).resolve(`${adapterId}/package.json`)
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

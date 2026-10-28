/**
 * AIP-72 memory stores, daemon side: which `FilesMemoryStore` a session
 * or a tool call reads and writes.
 *
 * One store per resolved root, kept for the daemon's lifetime (the store
 * serializes the mutations of one instance, so two instances over one
 * directory would not). The default root is `~/.agentproto/memory`,
 * overridable by the daemon config's `memory.root` (applied at boot, like
 * `sessions.eventsDir`), and an agent's AIP-42 `memory.store` wins when it
 * names a files root.
 */

import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import type { MemoryConfig } from "@agentproto/agent"
import { FilesMemoryStore, type MemoryStore } from "@agentproto/memory"

/**
 * The AIP-72 half of an AIP-42 agent's `memory` block. `scope`,
 * `retention_turns` and `semantic` configure conversation history and are
 * not read here.
 */
export type AgentMemoryBinding = Pick<MemoryConfig, "enabled" | "store" | "anchors">

let configuredRoot: string | undefined

function expandHome(dir: string): string {
  if (dir === "~") return homedir()
  if (dir.startsWith("~/")) return join(homedir(), dir.slice(2))
  return dir
}

/** Point the default store at `dir`. Called once at daemon boot from the
 *  loaded config (`memory.root`); `undefined` restores the hardcoded
 *  `~/.agentproto/memory`. A relative path resolves against the home
 *  directory, `~/` is expanded. */
export function setDefaultMemoryRoot(dir: string | undefined): void {
  if (!dir) {
    configuredRoot = undefined
    return
  }
  const expanded = expandHome(dir)
  configuredRoot = isAbsolute(expanded) ? expanded : join(homedir(), expanded)
}

/** The daemon's default store root: `memory.root`, else `~/.agentproto/memory`. */
export function defaultMemoryRoot(): string {
  return configuredRoot ?? join(homedir(), ".agentproto", "memory")
}

/**
 * Read the AIP-72 binding out of a manifest's `memory` value. Undefined
 * when the block carries none of `enabled`, `store`, `anchors` (a block
 * that only tunes conversation history does not bind the agent to memory
 * items).
 */
export function parseAgentMemoryBinding(raw: unknown): AgentMemoryBinding | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const binding: AgentMemoryBinding = {}
  if (typeof r.enabled === "boolean") binding.enabled = r.enabled
  if (typeof r.store === "string" && r.store.trim() !== "") binding.store = r.store.trim()
  if (Array.isArray(r.anchors)) {
    const anchors = r.anchors.filter((a): a is string => typeof a === "string" && a.trim() !== "")
    if (anchors.length > 0) binding.anchors = anchors.map(a => a.trim())
  }
  return Object.keys(binding).length > 0 ? binding : undefined
}

/**
 * Whether the spawn digest applies. AIP-42 defaults `enabled` to true, but
 * the daemon projects only for a manifest that states an AIP-72 binding
 * (`enabled: true`, a `store`, or `anchors`), so an existing manifest
 * whose `memory` block only tunes conversation history gets nothing new.
 * `enabled: false` always wins.
 */
export function memoryProjectionEnabled(binding: AgentMemoryBinding | undefined): boolean {
  return binding !== undefined && binding.enabled !== false
}

export interface ResolvedMemoryStoreRoot {
  root: string
  /** Set when the agent named a store the daemon cannot resolve. */
  warning?: string
}

/** A `memory.store` value that names a directory rather than a store id. */
function isFilesRoot(store: string): boolean {
  return store.startsWith(".") || store.startsWith("~") || isAbsolute(store) || store.includes("/")
}

/**
 * The store root for an agent's `memory.store`: a files root (absolute,
 * `~/`, or relative to the session's workspace) is used as is; no store
 * means the daemon default. A bare store id has no resolver yet (gbrain
 * and qdrant stores come later), so it falls back to the default with a
 * warning instead of failing the spawn.
 */
export function resolveMemoryStoreRoot(input: {
  store?: string
  workspaceRoot?: string
}): ResolvedMemoryStoreRoot {
  const store = input.store
  if (store === undefined) return { root: defaultMemoryRoot() }
  if (!isFilesRoot(store)) {
    return {
      root: defaultMemoryRoot(),
      warning:
        `memory: store "${store}" is not a files root and this daemon resolves no store ids; ` +
        `using the default store at ${defaultMemoryRoot()}.`,
    }
  }
  const expanded = expandHome(store)
  if (isAbsolute(expanded)) return { root: resolve(expanded) }
  return { root: resolve(input.workspaceRoot ?? process.cwd(), expanded) }
}

const stores = new Map<string, MemoryStore>()

/** The one `FilesMemoryStore` for `root` (normalized), created on first use. */
export function memoryStoreAt(root: string): MemoryStore {
  const key = resolve(root)
  let store = stores.get(key)
  if (!store) {
    store = new FilesMemoryStore({ root: key })
    stores.set(key, store)
  }
  return store
}

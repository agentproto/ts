/**
 * SQLite-backed memory for the agent, via Mastra's LibSQL store.
 *
 * Each ACP session is a memory *thread* (see acp-host.ts), so the agent recalls
 * earlier turns within a session. The db is a single SQLite file (LibSQL is a
 * SQLite fork) under `~/.agentproto/mastra-agent/` by default — persistent
 * across spawns — overridable with `AGENTPROTO_MASTRA_MEMORY_DB`.
 */

import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { LibSQLStore } from "@mastra/libsql"
import { Memory } from "@mastra/memory"
import type { MemoryConfig } from "@agentproto/agent"

/** A built Mastra memory — structural, matching `@agentproto/mastra`'s
 *  `MastraMemoryLike` expectation without importing the exact type. */
export type MastraMemoryLike = Memory

/** Resolve the SQLite file path, creating the parent dir. `AGENTPROTO_MASTRA_MEMORY_DB`
 *  wins; otherwise `~/.agentproto/mastra-agent/memory.db`. */
export function resolveMemoryDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.AGENTPROTO_MASTRA_MEMORY_DB
  if (override) return override
  const dir = join(homedir(), ".agentproto", "mastra-agent")
  mkdirSync(dir, { recursive: true })
  return join(dir, "memory.db")
}

/**
 * Build a Mastra `Memory` from an AIP-42 `memory:` config. Returns `undefined`
 * when memory is disabled (`scope: "none"`) so `buildMastraAgent` attaches none.
 *
 * - `retention_turns` → `options.lastMessages` (how many recent messages to
 *   replay into context). Defaults to 20.
 * - Semantic recall is left off (it needs an embedder + vector index) — this is
 *   conversation-history memory, the SQLite ask.
 */
export function buildSqliteMemory(
  config?: MemoryConfig,
  env: Record<string, string | undefined> = process.env,
): MastraMemoryLike | undefined {
  if (config?.scope === "none") return undefined
  const dbPath = resolveMemoryDbPath(env)
  const lastMessages =
    typeof config?.retention_turns === "number" && config.retention_turns > 0
      ? config.retention_turns
      : 20
  return new Memory({
    storage: new LibSQLStore({ id: "mastra-agent-memory", url: `file:${dbPath}` }),
    options: {
      lastMessages,
      semanticRecall: false,
      workingMemory: { enabled: false },
    },
  })
}

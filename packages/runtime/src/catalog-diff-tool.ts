/**
 * MCP tool `catalog_diff` — what changed in the LLM pricing catalog since the
 * last `catalog_diff` call on this machine.
 *
 * Deliberately side-effecting, like other sync tools: every call (1) builds
 * the CURRENT snapshot from `LLM_PRICING_CATALOG`, (2) loads the PREVIOUSLY
 * stored snapshot from `~/.agentproto/catalog-snapshot.json`, (3) diffs them,
 * and (4) persists "now" as the new baseline. First call ever: everything in
 * the catalog reports as `appeared`. Unlike `quota_status`, there is no
 * profile resolution — this operates on the whole catalog, not a named
 * profile.
 *
 * The diff itself comes from `diffCatalog` in `@agentproto/model-intel`
 * (locally stubbed in `catalog-diff-stub.ts` until that package's half
 * merges).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { LLM_PRICING_CATALOG } from "@agentproto/model-catalog/llm"
import { diffCatalog, type CatalogDiff, type CatalogSnapshot } from "./catalog-diff-stub.js"
import {
  loadCatalogSnapshotStore,
  recordCatalogSnapshot,
  type CatalogSnapshotStoreOptions,
} from "./catalog-snapshot-store.js"

export interface CatalogDiffDeps {
  /** Build the CURRENT snapshot. Defaults to mapping `LLM_PRICING_CATALOG`. */
  getCurrentCatalog?: () => CatalogSnapshot
  /** Store fns, injectable for tests. Defaults to the real
   *  `~/.agentproto/catalog-snapshot.json` file. */
  loadStore?: typeof loadCatalogSnapshotStore
  recordStore?: typeof recordCatalogSnapshot
}

export type CatalogDiffResult =
  | { ok: true; diff: CatalogDiff; asOf: string; previousAsOf: string | undefined }
  | { ok: false; message: string }

/** Map one `LLM_PRICING_CATALOG` entry to a `CatalogSnapshotEntry`. */
function toSnapshotEntry(pricing: { inputPer1M: number; outputPer1M: number }, id: string) {
  return {
    id,
    inputPer1M: pricing.inputPer1M,
    outputPer1M: pricing.outputPer1M,
    free: pricing.inputPer1M === 0 && pricing.outputPer1M === 0,
  }
}

function defaultCurrentCatalog(): CatalogSnapshot {
  const snapshot: CatalogSnapshot = {}
  for (const [id, pricing] of Object.entries(LLM_PRICING_CATALOG)) {
    snapshot[id] = toSnapshotEntry(pricing, id)
  }
  return snapshot
}

/**
 * Core of `catalog_diff`, transport-free so tests and other runtime surfaces
 * can call it without an MCP server. Never throws.
 */
export async function readCatalogDiff(deps: CatalogDiffDeps = {}): Promise<CatalogDiffResult> {
  let next: CatalogSnapshot
  try {
    next = deps.getCurrentCatalog ? deps.getCurrentCatalog() : defaultCurrentCatalog()
  } catch (error) {
    return {
      ok: false,
      message:
        "Failed to build the current catalog snapshot from LLM_PRICING_CATALOG " +
        `(should be impossible for a static import): ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const loadStore = deps.loadStore ?? loadCatalogSnapshotStore
  const recordStore = deps.recordStore ?? recordCatalogSnapshot
  const storeOpts: CatalogSnapshotStoreOptions = {}

  let previousAsOf: string | undefined
  let diff: CatalogDiff
  try {
    const stored = await loadStore(storeOpts)
    // Epoch marker (see catalog-snapshot-store.ts) means "never recorded" —
    // report no previous baseline rather than diffing against an empty catalog.
    previousAsOf = stored.asOf === "1970-01-01T00:00:00.000Z" ? undefined : stored.asOf
    diff = diffCatalog(stored.snapshot, next)
    await recordStore(next, storeOpts)
  } catch (error) {
    return {
      ok: false,
      message:
        "Failed to load/record the catalog snapshot under ~/.agentproto: " +
        `${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return { ok: true, diff, asOf: new Date().toISOString(), previousAsOf }
}

export function registerCatalogDiffTool(server: McpServer, deps: CatalogDiffDeps = {}): void {
  server.tool(
    "catalog_diff",
    "Diff the LLM pricing catalog against the last call's stored baseline. " +
      "Returns `appeared` / `removed` model ids, `priceChanged` (prev/next " +
      "inputPer1M & outputPer1M), and `freeToPaid` / `paidToFree`. " +
      "Side-effecting by design: each call also records the current catalog " +
      "as the new baseline, so consecutive calls report consecutive changes. " +
      "First call ever reports the whole catalog as `appeared`. `refresh` is " +
      "accepted for symmetry with quota_status and ignored: every call " +
      "already reads the live catalog.",
    {
      refresh: z
        .boolean()
        .optional()
        .describe(
          "Hint that a fresh read is wanted. Accepted and ignored: nothing is " +
            "cached, every call already reads the live catalog.",
        ),
    },
    async () => {
      const result = await readCatalogDiff(deps)
      if (result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                diff: result.diff,
                asOf: result.asOf,
                ...(result.previousAsOf !== undefined
                  ? { previousAsOf: result.previousAsOf }
                  : {}),
              }),
            },
          ],
        }
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ message: result.message }) }],
        isError: true as const,
      }
    },
  )
}

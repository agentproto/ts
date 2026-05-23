/**
 * Plugin manifest — `agentproto/plugin/v1`.
 *
 * Plugins declare what they provide in either:
 *   - their `package.json` under the `agentproto` key, OR
 *   - a standalone `agentproto.json` next to their `package.json`.
 *
 * The CLI reads this manifest, dynamic-imports each adapter entry,
 * and registers it with the runtime registry. Plugins don't need
 * side-effect imports any more — they just export their factory
 * functions and let the manifest do the wiring.
 *
 * Example (in @guilde/agentproto-bridge's package.json):
 *
 *   {
 *     "name": "@guilde/agentproto-bridge",
 *     "agentproto": {
 *       "schema": "agentproto/plugin/v1",
 *       "substrates": [
 *         {
 *           "kind": "guilde-mcp",
 *           "entry": "./dist/index.mjs",
 *           "export": "guildeMcpSubstrateFactory",
 *           "capabilities": ["mentions", "reactions", "identity"],
 *           "description": "Reads/writes turns through Guilde's MCP server."
 *         }
 *       ],
 *       "executors": [
 *         {
 *           "kind": "db-operator",
 *           "entry": "./dist/index.mjs",
 *           "export": "dbOperatorExecutorFactory",
 *           "description": "Delegates to Mastra operators via run_operator."
 *         }
 *       ]
 *     }
 *   }
 */

import { z } from "zod"

export const PLUGIN_MANIFEST_SCHEMA = "agentproto/plugin/v1" as const

const AdapterEntrySchema = z
  .object({
    /** The `kind` string the manifest's substrate/dispatcher/etc. block uses. */
    kind: z.string().min(1),
    /**
     * Path to the entry module, relative to the plugin package root.
     * Resolved via the plugin's `package.json#main`/`exports` (i.e. you
     * can use a subpath like `./dist/substrates.mjs` or an export name
     * like `.` if the plugin re-exports everything from its root).
     */
    entry: z.string().min(1),
    /** Named export inside `entry` — the factory function. */
    export: z.string().min(1),
    /** Free-form description; shown by `agentproto plugins show`. */
    description: z.string().optional(),
  })
  .loose()

const SubstrateEntrySchema = AdapterEntrySchema.extend({
  /**
   * Free-form capability tags. Not gated by the kernel yet, but
   * surfaced by `agentproto plugins show` so users can see what the
   * substrate claims to support (mentions, reactions, visibility, …).
   */
  capabilities: z.array(z.string()).optional(),
})

export const PluginManifestSchema = z
  .object({
    schema: z.literal(PLUGIN_MANIFEST_SCHEMA),
    substrates: z.array(SubstrateEntrySchema).default([]),
    dispatchers: z.array(AdapterEntrySchema).default([]),
    executors: z.array(AdapterEntrySchema).default([]),
    stateStores: z.array(AdapterEntrySchema).default([]),
  })
  .loose()

export type PluginManifest = z.infer<typeof PluginManifestSchema>
export type AdapterEntry = z.infer<typeof AdapterEntrySchema>
export type SubstrateEntry = z.infer<typeof SubstrateEntrySchema>

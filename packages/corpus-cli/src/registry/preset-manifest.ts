/**
 * Corpus preset manifest — `agentproto/corpus-preset/v1`.
 *
 * Preset packages declare what they provide in either:
 *   - their `package.json` under the `agentproto-corpus-preset` key, OR
 *   - a standalone `agentproto-corpus-preset.json` next to package.json.
 *
 * Example (in @agentproto/corpus-presets's package.json):
 *
 *   {
 *     "name": "@agentproto/corpus-presets",
 *     "agentproto-corpus-preset": {
 *       "schema": "agentproto/corpus-preset/v1",
 *       "presets": [
 *         {
 *           "slug": "marketing",
 *           "entry": "./dist/marketing/index.mjs",
 *           "export": "MarketingCorpusPreset",
 *           "description": "Marketing knowledge corpus — principles, patterns, critiques."
 *         }
 *       ]
 *     }
 *   }
 *
 * The corpus CLI walks every package listed in
 * `~/.agentproto/config.json` under `corpusPresetPackages[]` (default:
 * `["@agentproto/corpus-presets"]`), collects every preset they
 * declare, and resolves `corpus init <slug>` against the merged set.
 */

import { z } from "zod"

export const CORPUS_PRESET_MANIFEST_SCHEMA = "agentproto/corpus-preset/v1" as const

const PresetEntrySchema = z
  .object({
    /** The slug `corpus init <slug>` matches. */
    slug: z.string().regex(/^[a-z][a-z0-9-]*$/),
    /** Path to the entry module, relative to the preset package root. */
    entry: z.string().min(1),
    /** Named export inside `entry` — the CorpusPreset constant. */
    export: z.string().min(1),
    /** Free-form description; shown when listing available slugs. */
    description: z.string().optional(),
  })
  .loose()

export const CorpusPresetManifestSchema = z
  .object({
    schema: z.literal(CORPUS_PRESET_MANIFEST_SCHEMA),
    presets: z.array(PresetEntrySchema).default([]),
  })
  .loose()

export type CorpusPresetManifest = z.infer<typeof CorpusPresetManifestSchema>
export type CorpusPresetEntry = z.infer<typeof PresetEntrySchema>

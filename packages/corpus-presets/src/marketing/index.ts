/**
 * Marketing corpus preset.
 *
 * Pure TS data — `files` is inlined from the M0 fixture workspace at
 * build time via `scripts/gen-marketing.mjs`. The M0 conformance test
 * proves every file validates against the actual AgentProto JSON
 * Schemas, so a host that writes these to disk gets a known-good
 * starter workspace.
 *
 * Usage:
 *
 *     import { MarketingCorpusPreset } from "@agentproto/corpus-presets/marketing"
 *     for (const [rel, content] of Object.entries(MarketingCorpusPreset.files)) {
 *       await fs.writeFile(path.join(workspaceRoot, rel), content)
 *     }
 */

import type { CorpusPreset } from "@agentproto/corpus"
import { MARKETING_PRESET_FILES } from "./files.js"

export const MarketingCorpusPreset: CorpusPreset = Object.freeze({
  slug: "marketing",
  title: "Marketing Expert Corpus",
  description:
    "Autonomous marketing knowledge — principles, patterns, critiques, playbooks. Composes AIP-10/12/18/9/15/41 into a closed-loop improvement system.",
  files: MARKETING_PRESET_FILES,
})

// Re-export the raw file map for callers that want it directly.
export { MARKETING_PRESET_FILES }

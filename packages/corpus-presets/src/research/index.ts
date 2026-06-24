/**
 * Research corpus preset.
 *
 * Pure TS data — `files` is inlined from the M0 fixture workspace at
 * build time via `scripts/gen-research.mjs`. The M0 conformance test
 * proves every file validates against the actual AgentProto JSON
 * Schemas, so a host that writes these to disk gets a known-good
 * starter workspace.
 *
 * Usage:
 *
 *     import { ResearchCorpusPreset } from "@agentproto/corpus-presets/research"
 *     for (const [rel, content] of Object.entries(ResearchCorpusPreset.files)) {
 *       await fs.writeFile(path.join(workspaceRoot, rel), content)
 *     }
 */

import type { CorpusPreset } from "@agentproto/corpus"
import { RESEARCH_PRESET_FILES } from "./files.js"

export const ResearchCorpusPreset: CorpusPreset = Object.freeze({
  slug: "research",
  title: "Research Expert Corpus",
  description:
    "Domain-agnostic research knowledge — principles, patterns, critiques. Composes AIP-10/18/9/15/41 into a closed-loop discovery-and-improvement system.",
  files: RESEARCH_PRESET_FILES,
})

// Re-export the raw file map for callers that want it directly.
export { RESEARCH_PRESET_FILES }

/**
 * Action projection — `<kind>:<verb>` namespaced strings derived from
 * each model's per-kind capability object.
 *
 * Convention:
 *   - `image:generate`, `image:edit`, `image:upscale`, `image:reference`
 *   - `video:text_to`, `video:image_to`, `video:subject_reference`,
 *     `video:audio`
 *   - `audio:tts`, `audio:stt`, `audio:realtime`
 *   - `llm:vision`, `llm:tool_use`, `llm:reasoning`, `llm:long_context`
 *
 * Always `<kind>:<verb_or_modifier>`, snake_case.
 *
 * Action tags share a string array with curation tags but live behind the
 * reserved `<kind>:` prefix. Curation tags MUST NOT use the prefix —
 * `assertReservedPrefixDiscipline` enforces this at module load.
 *
 * The reason this lives in the catalog package (not enrichment) is that
 * actions are intrinsic to a model — derived from its capability fields,
 * not subjectively curated. Keeping the projection separate makes it
 * trivially callable from anywhere (e.g. a UI badge component) without
 * pulling the heuristic enrichment table.
 */

import type { ResolvedModel } from "./index.js"

const RESERVED_KIND_PREFIXES = ["llm:", "image:", "video:", "audio:"] as const

/**
 * Compute the action tags a model supports. Returns an empty array for
 * models with no recognized capability bits (defensive — never throws).
 */
export function getActions(model: ResolvedModel): string[] {
  switch (model.kind) {
    case "image": {
      const out: string[] = []
      const c = model.def.capabilities
      if (c.generate) out.push("image:generate")
      if (c.edit) out.push("image:edit")
      if (c.upscale) out.push("image:upscale")
      if (model.def.referenceImages.supported) out.push("image:reference")
      return out
    }
    case "video": {
      const out: string[] = []
      const c = model.def.capabilities
      if (c.textToVideo) out.push("video:text_to")
      if (c.imageToVideo) out.push("video:image_to")
      if (c.subjectReference) out.push("video:subject_reference")
      if (c.audio) out.push("video:audio")
      return out
    }
    case "audio": {
      const out: string[] = []
      const c = model.def.capabilities
      // One action per enabled modality (a model may do more than one).
      if (c.tts) out.push("audio:tts")
      if (c.stt) out.push("audio:stt")
      if (c.s2s) out.push("audio:s2s")
      if (c.voiceCloning) out.push("audio:voice_cloning")
      if (c.streaming) out.push("audio:streaming")
      if (c.diarization) out.push("audio:diarization")
      if (c.timestamps) out.push("audio:timestamps")
      return out
    }
    case "voice":
      // Voice metadata represents a render-target, not an action — tag it
      // with the engine modality so it matches the same action vocabulary
      // as audio models (s2s engines vs sequential tts).
      return model.voice.provider === "openai-realtime" ||
        model.voice.provider === "gemini-live"
        ? ["audio:s2s"]
        : ["audio:tts"]
    case "llm": {
      // LLM actions piggyback on the catalog-attached capability metadata
      // when present. The legacy `LLMPricing` shape doesn't carry
      // capabilities directly — those live in the agent-framework
      // catalog (to be folded into model-catalog/llm in a future phase).
      // For v1, infer from canonical id heuristics. Keep conservative:
      // only emit actions we can prove from the id.
      const out: string[] = []
      const id = model.canonicalId.toLowerCase()
      // Tool use: every modern frontier LLM supports it. Bare `gpt`,
      // `claude`, `gemini` are tool-capable; small fast variants
      // (haiku, mini, flash, lite) are too. We assume yes unless the
      // id obviously rules it out.
      out.push("llm:tool_use")
      // Reasoning: opus / sonnet / pro / r1 / o1 / o3 / thinking models.
      if (
        /opus|sonnet|claude-3.7|gpt-4\.5|gpt-5|gemini-.*-pro|deepseek-r1|o1|o3|thinking|reasoning/.test(
          id
        )
      ) {
        out.push("llm:reasoning")
      }
      // Vision: Sonnet, Opus, GPT-4o, Gemini, multimodal-marked ids.
      if (
        /sonnet|opus|gpt-4o|gpt-5|gemini|claude-3|claude-haiku-4|vision|vl/.test(
          id
        )
      ) {
        out.push("llm:vision")
      }
      // Long context: Gemini, GPT-4.1, Sonnet 4 (1M), Kimi, Grok 4 fast.
      if (
        /gemini|gpt-4\.1|claude-sonnet-4|kimi|grok-4|qwen3-next|long.context/.test(
          id
        )
      ) {
        out.push("llm:long_context")
      }
      return out
    }
  }
}

/**
 * Validate that a string array intended as curation tags does not use a
 * reserved `<kind>:` prefix. Run at module load on the explicit
 * enrichment map; throws on violation so the offending entry is caught
 * before any access decision is made.
 *
 * Caller pattern (in tests / module-load init):
 *   for (const e of Object.values(EXPLICIT_ENRICHMENT))
 *     assertReservedPrefixDiscipline(e.tags)
 */
export function assertReservedPrefixDiscipline(
  curationTags: readonly string[]
): void {
  for (const tag of curationTags) {
    for (const prefix of RESERVED_KIND_PREFIXES) {
      if (tag.startsWith(prefix)) {
        throw new Error(
          `Reserved tag prefix "${prefix}" used in curation tag "${tag}". ` +
            `Action tags (\`<kind>:<verb>\`) are derived automatically by ` +
            `getActions() — do not put them in curation arrays.`
        )
      }
    }
  }
}

/**
 * Returns true iff the given tag is in the reserved action-tag namespace.
 * Useful for callers that need to display curation tags only (e.g.
 * an admin UI) without hardcoding the prefix list.
 */
export function isActionTag(tag: string): boolean {
  return RESERVED_KIND_PREFIXES.some(p => tag.startsWith(p))
}

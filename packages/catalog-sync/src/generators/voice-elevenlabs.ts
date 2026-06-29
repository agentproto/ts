/**
 * voice-elevenlabs generator — reads the ElevenLabs /v1/voices snapshot and
 * emits a CatalogVoice[]-shaped generated TS file.
 *
 * The raw → CatalogVoice mapping lives in
 * `@agentproto/model-catalog/providers` (shared with the runtime
 * live-on-setup path); this generator only fetches, validates, and
 * serializes. Provider-native ids only; no product-specific aliases.
 */

import {
  ElevenLabsVoicesSnapshotSchema,
  mapElevenLabsVoices,
} from "@agentproto/model-catalog/providers"

import type {
  CatalogGenerator,
  CatalogSource,
  GeneratedFiles,
  GeneratorContext,
} from "../types.js"
import { defineGenerator } from "../types.js"
import { serializeVoiceModule } from "./serialize-voices.js"

// `id` MUST match the snapshot filename stem — the framework's
// `ctx.fetchSource` resolves `snapshots/<id>.json` (and is the single,
// dist-safe reader; generators never touch the filesystem themselves).
export const ELEVENLABS_SOURCE: CatalogSource = {
  id: "voice-elevenlabs",
  url: "https://api.elevenlabs.io/v1/voices",
  // Live refresh needs the account key; offline reads ignore this.
  headers: { "xi-api-key": "env:ELEVENLABS_API_KEY" },
}

const OUTPUT_PATH = "packages/catalog-sync/generated/voice-elevenlabs.generated.ts"

export const voiceElevenlabs: CatalogGenerator = defineGenerator({
  name: "voice:elevenlabs",
  modality: "voice",
  sources: [ELEVENLABS_SOURCE],

  async generate(ctx: GeneratorContext): Promise<GeneratedFiles> {
    // Snapshot-first (refresh re-fetches) — both handled by the framework.
    const snapshot = ElevenLabsVoicesSnapshotSchema.parse(
      await ctx.fetchSource(ELEVENLABS_SOURCE),
    )
    const voices = mapElevenLabsVoices(snapshot)
    return {
      [OUTPUT_PATH]: serializeVoiceModule(
        "voice:elevenlabs",
        "ELEVENLABS_VOICES",
        voices,
      ),
    }
  },
})

/**
 * voice-minimax generator — reads the MiniMax /v1/get_voice snapshot and
 * emits a CatalogVoice[]-shaped generated TS file.
 *
 * The raw → CatalogVoice mapping lives in
 * `@agentproto/model-catalog/providers` (shared with the runtime
 * live-on-setup path); this generator only fetches, validates, and
 * serializes. Provider-native ids only; no product-specific aliases.
 */

import {
  mapMinimaxVoices,
  MinimaxVoicesSnapshotSchema,
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
// `ctx.fetchSource` resolves `snapshots/<id>.json` (single dist-safe reader;
// generators never touch the filesystem themselves).
export const MINIMAX_SOURCE: CatalogSource = {
  id: "voice-minimax",
  url: "https://api.minimax.io/v1/get_voice",
  // get_voice is a POST; live refresh needs the account key (Bearer). Without
  // MINIMAX_API_KEY set, the framework reuses the committed snapshot.
  method: "POST",
  headers: {
    Authorization: "Bearer env:MINIMAX_API_KEY",
    "Content-Type": "application/json",
  },
  body: { voice_type: "system" },
}

const OUTPUT_PATH = "packages/catalog-sync/generated/voice-minimax.generated.ts"

export const voiceMinimax: CatalogGenerator = defineGenerator({
  name: "voice:minimax",
  modality: "voice",
  sources: [MINIMAX_SOURCE],

  async generate(ctx: GeneratorContext): Promise<GeneratedFiles> {
    // Snapshot-first (refresh re-fetches) — both handled by the framework.
    const snapshot = MinimaxVoicesSnapshotSchema.parse(
      await ctx.fetchSource(MINIMAX_SOURCE),
    )
    const voices = mapMinimaxVoices(snapshot)
    return {
      [OUTPUT_PATH]: serializeVoiceModule(
        "voice:minimax",
        "MINIMAX_VOICES",
        voices,
      ),
    }
  },
})

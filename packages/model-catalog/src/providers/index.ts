/**
 * Provider raw → CatalogVoice mappers.
 *
 * The shared seam between the two consumers of provider catalog data:
 *   - `@agentproto/catalog-sync` (build time) — turns a pinned snapshot into
 *     the committed baseline `*.generated.ts`;
 *   - the runtime live-on-setup path — turns a freshly-fetched account
 *     library into the local overlay cache.
 *
 * Both call the SAME deterministic mapper, so the live overlay and the
 * committed baseline are always shape-compatible. The exported zod schemas
 * validate either a pinned snapshot or a live response.
 */

export {
  mapElevenLabsVoice,
  mapElevenLabsVoices,
  ElevenLabsRawVoiceSchema,
  ElevenLabsVoicesSnapshotSchema,
} from "../voice/providers/elevenlabs-map.js"
export type {
  ElevenLabsRawVoice,
  ElevenLabsVoicesSnapshot,
} from "../voice/providers/elevenlabs-map.js"

export {
  mapMinimaxVoice,
  mapMinimaxVoices,
  MinimaxSystemVoiceSchema,
  MinimaxVoicesSnapshotSchema,
} from "../voice/providers/minimax-map.js"
export type {
  MinimaxSystemVoice,
  MinimaxVoicesSnapshot,
} from "../voice/providers/minimax-map.js"

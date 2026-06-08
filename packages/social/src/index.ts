/**
 * @agentproto/social — platform-neutral social footprint capture.
 *
 * Capture a person's footprint once (SocialSourcePort), fan it out to two
 * pure sinks: AIP-10 corpus sources (their voice) and social-graph ops
 * (their network). Downstream, @agentproto/corpus distills the voice into
 * a character knowledge base and @agentproto/persona synthesizes a twin.
 *
 * Pure: zero runtime, zero filesystem, zero HTTP — all I/O via injected
 * ports (see ./ports).
 */

export const SPEC_NAME = "agentsocial/v1" as const
export const SPEC_VERSION = "0.1.0-alpha" as const

// Model
export {
  ALL_SLICES,
  sliceOf,
  isVoiceRecord,
} from "./model/footprint.js"
export type {
  Slice,
  FootprintPerson,
  MediaRef,
  ProfileRecord,
  ExperienceEntry,
  PostRef,
  PostRecord,
  EngagementGivenRecord,
  EngagementReceivedRecord,
  ConnectionRecord,
  FootprintRecord,
} from "./model/footprint.js"

// Ports (also available at @agentproto/social/ports). The transport seam
// the platform adapters consume lives host-side in @agstudio/browser-social,
// not here — this kit is pure (zero browser dependency).
export type {
  SocialSourcePort,
  CaptureOptions,
  SliceSupport,
} from "./ports/social-source.port.js"
export type {
  GraphSinkPort,
  GraphOp,
  GraphPerson,
  GraphPost,
  GraphEngagement,
  GraphOrg,
} from "./ports/graph-sink.port.js"
export type {
  FootprintIndexPort,
  FootprintIndexRow,
  MediaIndexRow,
} from "./ports/footprint-index.port.js"
export type { MediaArchivePort, StoredMedia } from "./ports/media-archive.port.js"

// Capture
export { captureFootprint } from "./capture.js"
export type { CaptureResult } from "./capture.js"

// Depth — named profiles (quick/standard/deep/exhaustive) → concrete knobs
export {
  DEPTH_PROFILES,
  resolveDepth,
  isDepthName,
} from "./depth.js"
export type { DepthSettings, DepthName } from "./depth.js"

// Goal harness — capture until an objective is met (early-abort)
export { captureToGoal } from "./goal.js"
export type {
  CaptureGoal,
  GoalTally,
  CaptureToGoalOptions,
  CaptureToGoalResult,
} from "./goal.js"

// Land — corpus sink
export { footprintToSources } from "./land/footprint-to-corpus.js"
export type { FootprintToCorpusOptions } from "./land/footprint-to-corpus.js"
export {
  SocialImporter,
  makeSocialCandidateMapper,
} from "./land/social-importer.js"

// Land — graph sink
export {
  footprintToGraphOps,
  runGraphSink,
} from "./land/footprint-to-graph.js"
export type { GraphSubject } from "./land/footprint-to-graph.js"
export { archiveFootprintMedia } from "./land/archive-media.js"
export type { ArchiveMediaOptions } from "./land/archive-media.js"

// Distill — character profile (the prompt that maps posts → character signal)
export {
  buildCharacterDistillPrompt,
  parseCharacterItems,
  CHARACTER_TAG,
} from "./distill/character.profile.js"

// Synth — character entries → AIP-25 persona shell (the twin projection)
export { entriesToPersona } from "./synth/footprint-to-persona.js"
export type {
  CharacterEntry,
  SynthSubject,
  SynthesizedPersona,
  SynthOptions,
} from "./synth/footprint-to-persona.js"

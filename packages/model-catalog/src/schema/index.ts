import { z } from "zod"
import { LLMEntrySchema } from "./llm.js"
import { ImageEntrySchema } from "./image.js"
import { VideoEntrySchema } from "./video.js"
import { AudioEntrySchema } from "./audio.js"

export * from "./base.js"
export * from "./llm.js"
export * from "./image.js"
export * from "./video.js"
export * from "./audio.js"
export * from "./voice.js"

/** Discriminated union over every kind. */
export const ModelEntrySchema = z.discriminatedUnion("kind", [
  LLMEntrySchema,
  ImageEntrySchema,
  VideoEntrySchema,
  AudioEntrySchema,
])
export type ModelEntry = z.infer<typeof ModelEntrySchema>

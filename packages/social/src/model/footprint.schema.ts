/**
 * Runtime schema for the footprint file format — the cross-product handoff
 * artifact a capture surface writes and a landing surface reads.
 *
 * `model/footprint.ts` stays the source of truth for the in-code types; this
 * is their runtime mirror plus the file envelope (schemaVersion / capturedAt /
 * subject). Validation is pure computation — it keeps the kit's "zero I/O"
 * property intact.
 *
 * Object schemas are `.loose()` so a newer capture carrying extra fields
 * round-trips through an older lander unchanged (forward compatibility for an
 * evolving contract). `parseFootprintFile` also accepts the two legacy shapes
 * a file on disk may still be in: a bare `FootprintRecord[]` array, and the
 * envelope-less `{ profile, records }` object.
 */

import { z } from "zod"

import type {
  ConnectionRecord,
  EngagementGivenRecord,
  EngagementReceivedRecord,
  FootprintPerson,
  FootprintRecord,
  MediaRef,
  PostRecord,
  PostRef,
  ProfileRecord,
} from "./footprint.js"

/** Bump on a breaking change to the on-disk shape. */
export const SCHEMA_VERSION = "1.0.0" as const

/** `?: T | null` — absent or explicitly null, both accepted. */
const nullish = <T extends z.ZodTypeAny>(inner: T) => inner.nullish()

export const zFootprintPerson = z
  .object({
    platform: z.string(),
    handle: z.string(),
    name: nullish(z.string()),
    headline: nullish(z.string()),
    bio: nullish(z.string()),
    location: nullish(z.string()),
    profileUrl: nullish(z.string()),
    followerCount: nullish(z.number()),
    verified: nullish(z.boolean()),
  })
  .loose()

export const zExperienceEntry = z
  .object({
    company: z.string(),
    title: nullish(z.string()),
    start: nullish(z.string()),
    end: nullish(z.string()),
    current: z.boolean().optional(),
    location: nullish(z.string()),
  })
  .loose()

export const zMediaRef = z
  .object({
    type: z.enum(["image", "video", "gif", "document"]),
    url: z.string(),
    thumbUrl: nullish(z.string()),
    alt: nullish(z.string()),
    width: nullish(z.number()),
    height: nullish(z.number()),
    durationMs: nullish(z.number()),
    stored: z
      .object({
        sha256: z.string(),
        key: z.string(),
        bytes: nullish(z.number()),
        contentType: nullish(z.string()),
      })
      .loose()
      .optional(),
  })
  .loose()

export const zPostRef = z
  .object({
    platform: z.string(),
    urn: z.string(),
    authorHandle: z.string(),
    text: nullish(z.string()),
    url: nullish(z.string()),
    createdAt: nullish(z.string()),
    numLikes: nullish(z.number()),
    numComments: nullish(z.number()),
    numReposts: nullish(z.number()),
    media: z.array(zMediaRef).optional(),
  })
  .loose()

export const zProfileRecord = z
  .object({
    ...zFootprintPerson.shape,
    kind: z.literal("profile"),
    experience: z.array(zExperienceEntry).optional(),
  })
  .loose()

export const zPostRecord = z
  .object({
    ...zPostRef.shape,
    kind: z.literal("post"),
    subtype: z.enum(["post", "reply", "quote", "thread"]),
    replyToUrn: nullish(z.string()),
    replyToHandle: nullish(z.string()),
    quotedUrn: nullish(z.string()),
    quoted: zPostRef.optional(),
  })
  .loose()

export const zEngagementGivenRecord = z
  .object({
    kind: z.literal("engagement-given"),
    platform: z.string(),
    actorHandle: z.string(),
    action: z.enum(["like", "repost", "reply"]),
    target: zPostRef,
    targetAuthor: zFootprintPerson.optional(),
    replyText: nullish(z.string()),
  })
  .loose()

export const zEngagementReceivedRecord = z
  .object({
    kind: z.literal("engagement-received"),
    platform: z.string(),
    postUrn: z.string(),
    action: z.enum(["like", "repost", "reply", "comment"]),
    actor: zFootprintPerson,
    text: nullish(z.string()),
  })
  .loose()

export const zConnectionRecord = z
  .object({
    kind: z.literal("connection"),
    platform: z.string(),
    direction: z.enum(["following", "follower"]),
    edge: z.enum(["FOLLOWS", "CONNECTED"]),
    person: zFootprintPerson,
  })
  .loose()

export const zFootprintRecord = z.discriminatedUnion("kind", [
  zProfileRecord,
  zPostRecord,
  zEngagementGivenRecord,
  zEngagementReceivedRecord,
  zConnectionRecord,
])

export const zFootprintSubject = z.object({
  platform: z.string(),
  handle: z.string(),
})
export type FootprintSubject = z.infer<typeof zFootprintSubject>

/**
 * The file envelope. `schemaVersion` defaults so legacy files validate;
 * `capturedAt` / `subject` are stamped by new writers and optional on read
 * (derive the subject from `profile` via `footprintSubject` when absent).
 */
export const zFootprintFile = z
  .object({
    schemaVersion: z.string().default(SCHEMA_VERSION),
    capturedAt: z.string().optional(),
    subject: zFootprintSubject.optional(),
    profile: zProfileRecord.nullable().optional(),
    records: z.array(zFootprintRecord).min(1),
  })
  .loose()

export type FootprintFile = z.infer<typeof zFootprintFile>

/** Lift the two legacy on-disk shapes into the current envelope. */
export function normalizeFootprintFile(json: unknown): unknown {
  if (Array.isArray(json)) return { records: json }
  return json
}

/** Validate (and normalize legacy shapes of) a parsed footprint file. */
export function parseFootprintFile(json: unknown): FootprintFile {
  return zFootprintFile.parse(normalizeFootprintFile(json))
}

/** Best-effort subject: the stamped one, else the profile's identity. */
export function footprintSubject(
  file: FootprintFile
): FootprintSubject | null {
  if (file.subject) return file.subject
  if (file.profile) {
    return { platform: file.profile.platform, handle: file.profile.handle }
  }
  return null
}

/**
 * Compile-time drift guard: the inferred schema types must stay assignable to
 * the hand-written interfaces in `footprint.ts`. If a field diverges, one of
 * these lines fails to typecheck — fix the schema, not this guard.
 */
type _AssertAssignable<A, _B extends A> = true
type _Person = _AssertAssignable<FootprintPerson, z.infer<typeof zFootprintPerson>>
type _Media = _AssertAssignable<MediaRef, z.infer<typeof zMediaRef>>
type _PostRef = _AssertAssignable<PostRef, z.infer<typeof zPostRef>>
type _Profile = _AssertAssignable<ProfileRecord, z.infer<typeof zProfileRecord>>
type _Post = _AssertAssignable<PostRecord, z.infer<typeof zPostRecord>>
type _EngGiven = _AssertAssignable<EngagementGivenRecord, z.infer<typeof zEngagementGivenRecord>>
type _EngRecv = _AssertAssignable<EngagementReceivedRecord, z.infer<typeof zEngagementReceivedRecord>>
type _Conn = _AssertAssignable<ConnectionRecord, z.infer<typeof zConnectionRecord>>
type _Record = _AssertAssignable<FootprintRecord, z.infer<typeof zFootprintRecord>>

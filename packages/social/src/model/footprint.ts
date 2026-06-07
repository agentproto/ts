/**
 * FootprintRecord — the normalized, platform-neutral shape every
 * SocialSourcePort adapter emits, regardless of whether the bytes came
 * from X's GraphQL, LinkedIn's Voyager, or Instagram's web-private API.
 *
 * One union, captured once, fanned out to two pure sinks:
 *   - land/footprint-to-corpus  → AIP-10 corpus sources (the subject's VOICE)
 *   - land/footprint-to-graph   → social-graph ops (the subject's NETWORK)
 *
 * The person/post shapes deliberately mirror @agstudio/graph-social's
 * PersonInput / PostInput so the graph mapping is a 1:1 structural copy —
 * the kit stays vendor-neutral (no @agstudio import) while the host
 * adapter maps without translation.
 */

/** The four independently-capturable slices of a footprint. */
export type Slice =
  | "authored" // their posts, threads, replies, quotes — the core voice signal
  | "engagement-given" // what THEY like/repost/reply-to — interests + casual voice
  | "engagement-received" // who likes/replies to THEM — audience + inner circle
  | "connections" // following / followers — the network graph

export const ALL_SLICES: readonly Slice[] = [
  "authored",
  "engagement-given",
  "engagement-received",
  "connections",
]

/** A person on one platform. Mirrors graph-social PersonInput. */
export interface FootprintPerson {
  readonly platform: string
  /** Stable per-platform key: vanity (LI) / username (X·IG) / handle. */
  readonly handle: string
  readonly name?: string | null
  readonly headline?: string | null
  readonly bio?: string | null
  readonly location?: string | null
  readonly profileUrl?: string | null
  readonly followerCount?: number | null
  readonly verified?: boolean | null
}

/** The captured subject's own profile card. */
export interface ProfileRecord extends FootprintPerson {
  readonly kind: "profile"
}

/** A lightweight reference to any post (the subject's, or someone else's). */
/** An image / video / gif / document attached to a post — referenced by URL. */
export interface MediaRef {
  readonly type: "image" | "video" | "gif" | "document"
  /**
   * Best/original media URL (video: the playable variant; image: the photo;
   * document: the source file, e.g. a LinkedIn slide deck PDF).
   */
  readonly url: string
  /** Poster/thumbnail still (set for video/gif; document: cover page). */
  readonly thumbUrl?: string | null
  /** Author-provided alt text, when present. */
  readonly alt?: string | null
  readonly width?: number | null
  readonly height?: number | null
  readonly durationMs?: number | null
  /**
   * Set once the bytes are archived to object storage (content-addressed).
   * Absent = reference-only (the `url` will eventually rot — esp. video).
   * The archive step is opt-in at capture; this is the forward-compat seam
   * so a referenced clip and a stored clip share one shape.
   */
  readonly stored?: {
    readonly sha256: string
    /** Storage key / workspace-relative path of the archived bytes. */
    readonly key: string
    readonly bytes?: number | null
    readonly contentType?: string | null
  }
}

export interface PostRef {
  readonly platform: string
  /** Stable post id, e.g. `x:1789…`. */
  readonly urn: string
  readonly authorHandle: string
  readonly text?: string | null
  readonly url?: string | null
  readonly createdAt?: string | null
  readonly numLikes?: number | null
  readonly numComments?: number | null
  readonly numReposts?: number | null
  /** Attached media (images/videos/gifs), referenced by URL. */
  readonly media?: readonly MediaRef[]
}

/**
 * A post AUTHORED by the subject (slice: authored). `subtype` distinguishes
 * a standalone post from a reply / quote / thread-segment — all are voice.
 */
export interface PostRecord extends PostRef {
  readonly kind: "post"
  readonly subtype: "post" | "reply" | "quote" | "thread"
  /** Set when subtype === "reply": the post being replied to. */
  readonly replyToUrn?: string | null
  readonly replyToHandle?: string | null
  /** Set when subtype === "quote": the quoted post's id. */
  readonly quotedUrn?: string | null
  /**
   * Set when subtype === "quote": the quoted post's CONTENT (text, author,
   * url, media) — so the voice unit is self-contained. `quotedUrn` is the
   * bare pointer; this is what they were actually reacting to.
   */
  readonly quoted?: PostRef
}

/**
 * Something the subject DID to someone else's post (slice: engagement-given).
 * `replyText` carries the subject's own words when action === "reply" — that
 * text is voice and lands in the corpus too.
 */
export interface EngagementGivenRecord {
  readonly kind: "engagement-given"
  readonly platform: string
  /** The subject. */
  readonly actorHandle: string
  readonly action: "like" | "repost" | "reply"
  /** The target post + its (other) author. */
  readonly target: PostRef
  /** Author of the target post — captured so the graph can link both ends. */
  readonly targetAuthor?: FootprintPerson
  readonly replyText?: string | null
}

/**
 * Someone who engaged with the SUBJECT's post (slice: engagement-received).
 * Graph-only by default (it's other people's signal about the subject).
 */
export interface EngagementReceivedRecord {
  readonly kind: "engagement-received"
  readonly platform: string
  /** The subject's post that was engaged with. */
  readonly postUrn: string
  readonly action: "like" | "repost" | "reply" | "comment"
  /** The engager. */
  readonly actor: FootprintPerson
  /** Their reply/comment text, when applicable. */
  readonly text?: string | null
}

/**
 * A follow / connection edge (slice: connections). `direction` is relative
 * to the subject; `edge` is the graph-social edge type.
 */
export interface ConnectionRecord {
  readonly kind: "connection"
  readonly platform: string
  readonly direction: "following" | "follower"
  readonly edge: "FOLLOWS" | "CONNECTED"
  readonly person: FootprintPerson
}

export type FootprintRecord =
  | ProfileRecord
  | PostRecord
  | EngagementGivenRecord
  | EngagementReceivedRecord
  | ConnectionRecord

/** Which slice a record belongs to — for filtering a buffered footprint. */
export function sliceOf(record: FootprintRecord): Slice {
  switch (record.kind) {
    case "profile":
    case "post":
      return "authored"
    case "engagement-given":
      return "engagement-given"
    case "engagement-received":
      return "engagement-received"
    case "connection":
      return "connections"
  }
}

/**
 * Records that carry the SUBJECT's own words — what belongs in the voice
 * corpus. Their own posts/replies/quotes, plus reply-text on engagements.
 */
export function isVoiceRecord(
  record: FootprintRecord
): record is PostRecord | EngagementGivenRecord {
  if (record.kind === "post") return Boolean(record.text?.trim())
  if (record.kind === "engagement-given")
    return record.action === "reply" && Boolean(record.replyText?.trim())
  return false
}

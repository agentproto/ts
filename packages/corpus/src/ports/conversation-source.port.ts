/**
 * ConversationSourcePort — the "conversation ref → turns" boundary the
 * ConversationImporter consumes. Symmetric with FetcherPort (URL → text):
 * it keeps the importer PURE and chat-store-agnostic. The importer decides
 * *what* to import (windowing, transcript shape, dedup hash); the port supplies
 * the one capability that is environment-bound — resolving a conversation
 * reference to its turns, wherever they live.
 *
 * Structural interface, NOT nominal — any object of this shape satisfies it.
 * Concrete implementations live where the messages live:
 *
 *   - a companion app over its Mastra thread store (per-user threads),
 *   - a guild runtime over its conversation log,
 *   - a fake (tests): canned turns per ref.
 *
 * Returning `null` lets the importer skip-with-warning rather than abort the
 * batch; throwing is reserved for hard failures (auth, store unreachable).
 */

/** One turn in a conversation. */
export interface ConversationTurn {
  /** Free-form speaker role — "user" | "assistant" | "system" | a name. */
  readonly role: string
  /** The turn's text, already flattened to plain text by the port. */
  readonly text: string
  /** ISO-8601 timestamp, when known — for provenance + window ordering. */
  readonly at?: string
}

/**
 * One resolved slice of conversation — the raw material a ConversationImporter
 * turns into a `knowledge.source`.
 */
export interface ConversationDoc {
  /**
   * Stable id for THIS slice — becomes the source slug base and the `sources:`
   * provenance ref. Chat is append-only, so for incremental distill the host
   * encodes the window here (e.g. `thread-123-2026-06-06`): a growing
   * conversation then yields a distinct source per window instead of colliding
   * on one immutable slug.
   */
  readonly id: string
  /** Human-readable title, when the store has one. */
  readonly title?: string
  /** The turns in chronological order. */
  readonly turns: readonly ConversationTurn[]
  /** BCP-47 language hint, when the store knows it. */
  readonly language?: string
}

export interface ConversationSourcePort {
  /** Resolve a conversation reference to its turns, or null to skip it. */
  fetchConversation(ref: string): Promise<ConversationDoc | null>
}

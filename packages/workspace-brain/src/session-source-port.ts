/**
 * `BrainSessionSourcePort` — the bridge between a session's EXPORTED
 * TRANSCRIPT (an `ExportedSession`-shaped document, produced by the host's
 * `readSession`) and the corpus `ConversationSourcePort` that
 * `ConversationImporter` consumes.
 *
 * The importer stays pure and chat-store-agnostic (per corpus's design): it
 * only knows "give me a conversation ref, get turns". This port supplies the
 * one environment-bound capability — turning a session reference into
 * turn-shaped text — by delegating the actual transcript read to the injected
 * {@link BrainConfig.readSession} and flattening the result to
 * `ConversationTurn`s.
 *
 * Returning `null` lets the importer skip-with-warning; a thrown error from
 * `readSession` is caught and converted to `null` so one unreadable session
 * never aborts a batch.
 */

import type {
  ConversationDoc,
  ConversationSourcePort,
  ConversationTurn,
} from "@agentproto/corpus"
import type { ExportedSessionLike } from "./types.js"

export interface BrainSessionSourcePortOptions {
  /** The injected transcript reader (workspace's conversation resolver). */
  readonly readSession: (ref: string) => Promise<ExportedSessionLike | null>
}

export class BrainSessionSourcePort implements ConversationSourcePort {
  constructor(private readonly opts: BrainSessionSourcePortOptions) {}

  async fetchConversation(ref: string): Promise<ConversationDoc | null> {
    let session: ExportedSessionLike | null
    try {
      session = await this.opts.readSession(ref)
    } catch {
      return null
    }
    if (!session) return null

    const turns: ConversationTurn[] = []
    for (const m of session.messages) {
      const text = m.text?.trim()
      // Skip tool rows with no readable text and empty turns — the importer's
      // `renderTranscript` drops empty turns anyway; filtering here avoids
      // building an all-empty doc we'd discard.
      if (!text) continue
      const at =
        typeof m.ts === "number" && Number.isFinite(m.ts)
          ? new Date(m.ts).toISOString()
          : undefined
      turns.push(at ? { role: m.role, text, at } : { role: m.role, text })
    }
    if (turns.length === 0) return null

    return {
      id: ref,
      ...(session.meta?.title ? { title: session.meta.title } : {}),
      turns,
    }
  }
}

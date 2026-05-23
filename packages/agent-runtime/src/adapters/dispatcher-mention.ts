/**
 * Mention dispatcher — selects participants whose displayName is
 * @-mentioned in the most recent turn.
 *
 * Skip rules:
 *   - never re-select the participant who authored the trigger turn
 *     (otherwise they'd reply to themselves indefinitely)
 *   - never dispatch on a trigger we already processed (in-memory cursor —
 *     prevents the loop from re-firing on the same @mention every poll
 *     when the kernel's own reply isn't yet visible in the next read).
 *     Per-dispatcher-instance state; a fresh swarm process starts with
 *     no cursor and naturally responds to the latest unhandled mention
 *     exactly once.
 *   - if no mentions match any known participant, return [] (idle)
 *
 * The parser itself lives in `../util/mention-parser.mjs` (vanilla JS)
 * so runtime profiles can stamp the same implementation into Claude
 * Code hooks at build time without depending on the TS build pipeline.
 */

import type {
  Dispatcher,
  DispatcherInput,
  ParticipantId,
  TurnId,
} from "../ports.js"
import { textContainsMention } from "../util/mention-parser.mjs"

export class MentionDispatcher implements Dispatcher {
  readonly kind = "mention"
  private lastProcessedTriggerId: TurnId | undefined

  async selectNext(input: DispatcherInput): Promise<readonly ParticipantId[]> {
    const trigger = input.recentTurns[input.recentTurns.length - 1]
    if (!trigger) return []
    if (trigger.id === this.lastProcessedTriggerId) return []
    const text = trigger.content

    const selected: ParticipantId[] = []
    for (const p of input.participants) {
      if (p.id === trigger.participantId) continue
      if (textContainsMention(text, p.displayName)) {
        selected.push(p.id)
      }
    }

    if (selected.length > 0) {
      this.lastProcessedTriggerId = trigger.id
    }
    return selected
  }
}

// Re-exported so callers writing their own adapters can detect
// mentions with identical semantics.
export { textContainsMention }

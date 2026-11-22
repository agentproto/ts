/**
 * Transcript dedup of the cascade (ported from agentik-studio
 * `packages/agent-framework/src/voice/turn-runner.ts` `createTurnDedupe`):
 * the three guards that stop voice from answering itself.
 *
 *   1. `replyInFlight` — drop a commit while a turn generates. NOT ported as
 *      a guard: the call pipeline is sequential by design, a second
 *      utterance is deferred behind the running turn instead of dropped.
 *   2. `recentCommits` — identical (normalized) user text inside
 *      `duplicateWindowMs`: the VAD splitting on an inhale, or a realtime
 *      vendor emitting partial + final, fires twice on one intent.
 *   3. `recentAssistant` — user text that overlaps what the assistant said
 *      inside `echoWindowMs` by at least `echoOverlapRatio` of its tokens:
 *      the operator's own TTS coming back through the mic because echo
 *      cancellation is not perfect. Without it a single "hi" triggers a
 *      reply, the reply is transcribed as user speech, and the assistant
 *      answers itself — the dup a user reports.
 *
 * Values come from defaults.ts; nothing here holds a tuning number.
 */
import { VOICE_DEFAULTS } from "../defaults.js"

export interface SttDedupOptions {
  /** Sliding window for identical transcripts. */
  duplicateWindowMs: number
  /** Window in which a transcript may match the assistant's own words. */
  echoWindowMs: number
  /** Token share that must match to call it an echo (0-1). */
  echoOverlapRatio: number
  /** Tokens shorter than this never count for the overlap. */
  minTokenLength: number
}

const D = VOICE_DEFAULTS.cascade.stt.dedup

export const DEFAULT_STT_DEDUP: SttDedupOptions = {
  duplicateWindowMs: D.duplicateWindowMs.value,
  echoWindowMs: D.echoWindowMs.value,
  echoOverlapRatio: D.echoOverlapRatio.value,
  minTokenLength: D.minTokenLength.value,
}

export interface SttDedup {
  /** True when `text` repeats a recent user transcript inside the window. */
  isDuplicateRecentText(text: string): boolean
  /** True when `text` echoes what the assistant said inside the echo window. */
  isAssistantEcho(text: string): boolean
  /** Record what the assistant said so its echo can be rejected. */
  recordAssistantUtterance(text: string): void
  /** Test observability: why the last transcript was dropped, when it was. */
  lastDrop(): "duplicate" | "assistant-echo" | undefined
}

/**
 * Build the per-session dedup state. Options are partial: an unset field
 * keeps its kit default.
 */
export function createSttDedup(opts: Partial<SttDedupOptions> = {}): SttDedup {
  const o: SttDedupOptions = { ...DEFAULT_STT_DEDUP, ...opts }
  const recentCommits = new Map<string, number>()
  const recentAssistant = new Map<string, number>()
  let dropped: "duplicate" | "assistant-echo" | undefined

  // Same normalize as the studio (lowercase, punctuation out, whitespace
  // collapsed), plus a final trim: the studio version left the space a
  // stripped punctuation mark protected, so "Bonjour !" and "bonjour" made
  // two keys instead of one.
  const normalize = (text: string): string =>
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
  const tokensOf = (text: string): string[] =>
    normalize(text).split(" ").filter(Boolean)

  const sweep = (map: Map<string, number>, ttl: number): void => {
    const now = Date.now()
    for (const [k, t] of map) if (now - t > ttl) map.delete(k)
  }

  return {
    isDuplicateRecentText(text) {
      sweep(recentCommits, o.duplicateWindowMs)
      const key = normalize(text)
      const last = recentCommits.get(key)
      const now = Date.now()
      if (last !== undefined && now - last < o.duplicateWindowMs) {
        dropped = "duplicate"
        return true
      }
      recentCommits.set(key, now)
      return false
    },
    isAssistantEcho(text) {
      sweep(recentAssistant, o.echoWindowMs)
      const tokens = tokensOf(text).filter(t => t.length >= o.minTokenLength)
      if (tokens.length === 0) return false
      let hits = 0
      for (const tok of tokens) if (recentAssistant.has(tok)) hits++
      if (hits / tokens.length >= o.echoOverlapRatio) {
        dropped = "assistant-echo"
        return true
      }
      return false
    },
    recordAssistantUtterance(text) {
      // Index by individual tokens so a partial match (STT only captured
      // half the sentence) still registers as an echo.
      sweep(recentAssistant, o.echoWindowMs)
      const now = Date.now()
      for (const tok of tokensOf(text)) {
        if (tok.length < o.minTokenLength) continue
        recentAssistant.set(tok, now)
      }
    },
    lastDrop: () => dropped,
  }
}

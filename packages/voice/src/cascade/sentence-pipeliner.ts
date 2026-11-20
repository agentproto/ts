/*
 * Ported from agentik-studio packages/agent-framework/src/voice/sentence-pipeliner.ts (PR #1114).
 */
/**
 * Sentence Pipeliner - streams LLM tokens into TTS calls at sentence
 * boundaries so we don't have to wait for the full reply before audio
 * starts. Time-to-first-audio drops from "STT + full LLM + TTS first
 * chunk" to "STT + first-sentence LLM + TTS first chunk" - typically
 * a 1–2 second improvement.
 *
 * Usage:
 *
 *   const pipe = new SentencePipeliner({
 *     onSentence: async sentence => streamTtsFor(sentence),
 *   })
 *   for await (const chunk of llmStream) pipe.push(chunk)
 *   await pipe.flush()  // emit any trailing text after last boundary
 *
 * Design choices:
 *   - Serial TTS execution: each onSentence call awaits before the next
 *     fires. Guarantees audio chunks arrive in spoken order without an
 *     explicit reorder queue. Trade-off: if TTS for sentence N is slow,
 *     sentence N+1 waits. In practice TTS streams fast enough that this
 *     stays smooth (the bottleneck is LLM token generation).
 *   - Min sentence length: don't fire TTS on a stray "Ok." - small
 *     fragments produce awkward audio and waste TTS round-trips. Below
 *     `minLength` we keep buffering until a longer sentence builds up.
 *   - Markdown stripping: voice mode prompt already discourages it, but
 *     belt + braces: drop `**bold**`, `[link](url)` etc. before TTS so
 *     the speaker doesn't say "asterisk asterisk bold asterisk asterisk".
 */
import { VOICE_DEFAULTS } from "../defaults.js"

export interface SentencePipelinerOptions {
  /** Called when a complete sentence is detected. Awaited serially. */
  onSentence: (sentence: string) => Promise<void>
  /**
   * Minimum sentence length (chars) before firing TTS. Sentences below
   * this stay in the buffer until they accumulate. Default 12.
   */
  minLength?: number
  /**
   * Time-to-first-audio lever: for the FIRST chunk of a turn only, a
   * clause boundary (`,` `;` `:` followed by whitespace) also releases
   * the buffer once it holds at least this many chars, instead of
   * waiting for the end of the first sentence. Later chunks only split
   * on sentence ends. Default 24; pass `Infinity` to disable.
   */
  firstClauseMinLength?: number
  /** Optional logger prefix for diagnostics. */
  logPrefix?: string
}

const SENTENCE_BOUNDARY = /([.!?]+["')\]]?\s+|\n+)/g
const FIRST_CHUNK_BOUNDARY = /([.!?]+["')\]]?\s+|\n+|[,;:]\s+)/g
const CLAUSE_ONLY = /^[,;:]\s+$/

const DEFAULT_MIN_LENGTH = VOICE_DEFAULTS.tts.split.minSentenceChars.value
const DEFAULT_FIRST_CLAUSE_MIN_LENGTH =
  VOICE_DEFAULTS.tts.split.firstClauseMinChars.value

/**
 * Operator kill switch / tuning for `firstClauseMinLength`, read from
 * `VOICE_TTS_FIRST_CLAUSE_MIN_CHARS`: unset or invalid keeps the default,
 * `off` or `0` disables the first-chunk clause split, a positive number
 * sets the threshold.
 */
export function firstClauseMinLengthFromEnv(
  value: string | undefined
): number | undefined {
  const v = value?.trim().toLowerCase()
  if (!v) return undefined
  if (v === "off" || v === "0") return Infinity
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export class SentencePipeliner {
  private buffer = ""
  private readonly minLength: number
  private readonly firstClauseMinLength: number
  private readonly onSentence: (s: string) => Promise<void>
  private readonly logPrefix: string
  private chain: Promise<void> = Promise.resolve()
  private sentenceCount = 0

  constructor(opts: SentencePipelinerOptions) {
    this.onSentence = opts.onSentence
    this.minLength = opts.minLength ?? DEFAULT_MIN_LENGTH
    this.firstClauseMinLength =
      opts.firstClauseMinLength ?? DEFAULT_FIRST_CLAUSE_MIN_LENGTH
    this.logPrefix = opts.logPrefix ?? "[sentence-pipeliner]"
  }

  /**
   * Append a streamed LLM chunk. Boundaries inside the chunk trigger
   * TTS calls immediately; partial trailing text stays buffered for
   * the next push or flush.
   */
  push(chunk: string): void {
    if (!chunk) return
    this.buffer += chunk
    this.drainSentences()
  }

  /**
   * Emit any text left in the buffer as a final sentence. Call once
   * the LLM stream completes. Resolves only after every queued TTS
   * call has finished.
   */
  async flush(): Promise<void> {
    const tail = this.buffer.trim()
    this.buffer = ""
    if (tail.length > 0) {
      this.enqueue(tail)
    }
    await this.chain
  }

  /** Number of sentences fired to TTS so far (post-strip). */
  get count(): number {
    return this.sentenceCount
  }

  private drainSentences(): void {
    // Walk the boundaries in order and release the first one whose
    // preceding text is long enough. A too-short sentence ("Ok.") is
    // NOT a stop: we keep scanning so it merges with the next sentence
    // and the whole thing fires at the next boundary. (Stopping at the
    // short one re-matched the same boundary on every push, so nothing
    // was spoken until flush() - the entire reply as one TTS call.)
    while (true) {
      const boundary =
        this.sentenceCount === 0 ? FIRST_CHUNK_BOUNDARY : SENTENCE_BOUNDARY
      let end = -1
      for (const m of this.buffer.matchAll(boundary)) {
        const upTo = m.index + m[0].length
        const candidate = this.buffer.slice(0, upTo).trim()
        const min = CLAUSE_ONLY.test(m[0])
          ? this.firstClauseMinLength
          : this.minLength
        if (candidate.length >= min) {
          end = upTo
          break
        }
      }
      if (end < 0) return
      const sentence = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end)
      this.enqueue(sentence)
    }
  }

  private enqueue(rawSentence: string): void {
    const cleaned = stripMarkdownForTts(rawSentence)
    if (!cleaned) return
    this.sentenceCount += 1
    this.chain = this.chain.then(async () => {
      try {
        await this.onSentence(cleaned)
      } catch (err) {
        console.error(`${this.logPrefix} onSentence failed`, {
          err: err instanceof Error ? err.message : String(err),
          sentence: cleaned.slice(0, 80),
        })
      }
    })
  }
}

/**
 * Strip markdown that would sound bad if read aloud. Voice-mode prompt
 * usually prevents the model from emitting these, but the model
 * sometimes still slips - strip defensively so the TTS layer never has
 * to deal with `**bold**` etc.
 */
export function stripMarkdownForTts(text: string): string {
  return (
    text
      // Bold/italic markers - keep the inner text
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
      .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
      // Inline code
      .replace(/`([^`]+)`/g, "$1")
      // Markdown links - keep the label, drop the URL
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Bare URLs - drop entirely (read-aloud URLs are awful)
      .replace(/https?:\/\/\S+/g, "")
      // Heading hashes / bullet markers at line start
      .replace(/^[#\->*]+\s+/gm, "")
      // Collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
  )
}

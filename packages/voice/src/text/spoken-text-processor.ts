import { defineTransformer, type TextChunk, type Transformer } from "../processors.js"
import { toSpokenText, type SpokenLocale } from "./spoken-text.js"

export interface SpokenTextProcessorOptions {
  /** Language the text is written in. Default "fr". */
  locale?: SpokenLocale
  /** Host labels to drop, see `toSpokenText`. */
  stripLabels?: readonly string[]
}

/** A sentence ends at `.`, `!`, `?` or `…` followed by whitespace ("3.14" does not end one), or at a line break. */
const BOUNDARY = /(?:[.!?…](?=\s)|\n)/g

function lastBoundary(text: string): number {
  let end = -1
  for (const m of text.matchAll(BOUNDARY)) end = m.index + m[0].length
  return end
}

/**
 * The reference `textOut` transformer: rewrites the reply into speakable text
 * (numbers, dates, money, abbreviations, markdown and emojis) before the TTS,
 * while the host keeps showing the reply as the brain wrote it.
 *
 * The brain streams text in pieces, so a number or a date can be cut between
 * two chunks ("12" then "00 €"). The processor therefore holds text back until
 * a sentence boundary or the end-of-reply chunk and normalizes whole sentences
 * only. Build one instance per session: it keeps the held text in its closure.
 * Text held for a turn that was cut (barge-in) is dropped when the next turn
 * starts. Brain events pass through untouched.
 */
export function spokenTextProcessor(options: SpokenTextProcessorOptions = {}): Transformer<"textOut"> {
  const locale = options.locale ?? "fr"
  const stripLabels = options.stripLabels
  let held = ""
  let turn: number | undefined

  const speak = (text: string): string => toSpokenText(text, locale, { stripLabels })

  return defineTransformer<"textOut">({
    name: "spoken-text",
    hook: "textOut",
    modifies: ["text"],
    run: (chunk: TextChunk, ctx): TextChunk | null => {
      if (chunk.event !== undefined && chunk.text === "") return chunk
      if (ctx.utteranceId !== turn) {
        held = ""
        turn = ctx.utteranceId
      }
      held += chunk.text

      if (chunk.end === true) {
        const spoken = speak(held)
        held = ""
        return { ...chunk, text: spoken }
      }

      const cut = lastBoundary(held)
      if (cut < 0) return null
      const sentence = held.slice(0, cut)
      held = held.slice(cut)
      let spoken = speak(sentence)
      if (spoken === "") return null
      // A line break ends a fragment without punctuation: keep the sentence break the pure function would have added.
      if (/\n$/.test(sentence) && !/[.!?…:,;]$/.test(spoken)) spoken += "."
      return { ...chunk, text: `${spoken} ` }
    },
  })
}

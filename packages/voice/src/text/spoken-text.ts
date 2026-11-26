/**
 * Spoken-text normalization for any TTS path.
 *
 * Replies are written for chat display: arrow bullets, markdown bold,
 * emojis, `---` separators. Fed raw to a TTS they produce garbled audio
 * (formatting tokens read aloud). This module strips them and rewrites
 * written-only forms to spoken words in CODE, never by asking a model:
 * integers, decimals, times, dates, money, percentages, ordinals, common
 * abbreviations and unambiguous units (French first, English second).
 * It is deterministic and idempotent, and leaves phone numbers, URLs and
 * long ids out of the spoken text.
 *
 * Pure: no I/O, no environment, no provider. Limits (characters per note,
 * total duration) are host policy and are not defined here.
 */

export type SpokenLocale = "fr" | "en"

/**
 * Speech rate assumed for duration estimates: about 15 characters per
 * second of spoken audio. Exposed so callers can size or split an audio
 * reply without inventing a second rate.
 */
export const SPEECH_CHARS_PER_SECOND = 15

export interface ToSpokenTextOptions {
  /**
   * Whole-segment labels to drop from the text, for example delivery-channel
   * words a model writes into its own reply ("Voice sent", "In writing").
   * Matched case-insensitively and only as a WHOLE segment: alone between
   * arrow or bullet glyphs, or at the start of the text or after a sentence
   * boundary, as a whole word ended by a terminator or the end of the text.
   * A label that merely heads a longer phrase is kept. Nothing is stripped by
   * default: the label list is host policy.
   */
  stripLabels?: readonly string[]
}

const SEGMENT_GLYPHS = /[→←►▶◀•▪◦‣·]/

/**
 * Drop the segments of one line (split on arrow / bullet glyphs) that consist
 * of nothing but a declared label, ignoring markdown, emojis and edge
 * punctuation: "→ **Voice sent** → **hello**" keeps only "hello".
 */
function bareSegment(segment: string): string {
  return segment
    .replace(/\*\*|__|[*_~`#|]/g, " ")
    .replace(/\p{Extended_Pictographic}|[️‍]/gu, "")
    .replace(/[\s.!?…:,;-]+/gu, " ")
    .trim()
    .toLowerCase()
}

function dropLabelSegments(line: string, labels: ReadonlySet<string>): string {
  return line
    .split(SEGMENT_GLYPHS)
    .filter(segment => !labels.has(bareSegment(segment)))
    .join(" → ")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ---------------------------------------------------------------------------
// Number words
// ---------------------------------------------------------------------------

const FR_UNITS = [
  "zéro",
  "un",
  "deux",
  "trois",
  "quatre",
  "cinq",
  "six",
  "sept",
  "huit",
  "neuf",
  "dix",
  "onze",
  "douze",
  "treize",
  "quatorze",
  "quinze",
  "seize",
]

const FR_TENS = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante"]

function frUnder100(n: number): string {
  if (n < 17) return FR_UNITS[n]!
  if (n < 20) return `dix-${FR_UNITS[n - 10]}`
  if (n < 70) {
    const tens = FR_TENS[Math.floor(n / 10)]!
    const rem = n % 10
    if (rem === 0) return tens
    if (rem === 1) return `${tens} et un`
    return `${tens}-${FR_UNITS[rem]}`
  }
  if (n < 80) {
    const rem = n - 60
    if (rem === 11) return "soixante et onze"
    return `soixante-${frUnder100(rem)}`
  }
  const rem = n - 80
  if (rem === 0) return "quatre-vingts"
  return `quatre-vingt-${frUnder100(rem)}`
}

function frUnder1000(n: number): string {
  if (n < 100) return frUnder100(n)
  const hundreds = Math.floor(n / 100)
  const rem = n % 100
  const base = hundreds === 1 ? "cent" : `${FR_UNITS[hundreds]} cent`
  if (rem === 0) return hundreds === 1 ? base : `${base}s`
  return `${base} ${frUnder100(rem)}`
}

function frInteger(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  const negative = value < 0
  let n = Math.floor(Math.abs(value))
  if (n === 0) return negative ? "moins zéro" : "zéro"

  // Beyond the largest named scale there are no words: keep the digits.
  if (n >= 1e12) return String(value)
  const scales = ["", "mille", "million", "milliard"]
  const groups: number[] = []
  while (n > 0) {
    groups.push(n % 1000)
    n = Math.floor(n / 1000)
  }

  const parts: string[] = []
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!
    if (g === 0) continue
    if (i === 0) {
      parts.push(frUnder1000(g))
    } else if (i === 1) {
      parts.push(g === 1 ? "mille" : `${frUnder1000(g)} mille`)
    } else {
      const scale = scales[i]!
      parts.push(g === 1 ? `un ${scale}` : `${frUnder1000(g)} ${scale}s`)
    }
  }
  return `${negative ? "moins " : ""}${parts.join(" ")}`
}

const EN_ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
]

const EN_TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
]

function enUnder100(n: number): string {
  if (n < 20) return EN_ONES[n]!
  const tens = EN_TENS[Math.floor(n / 10)]!
  const rem = n % 10
  return rem === 0 ? tens : `${tens}-${EN_ONES[rem]}`
}

function enUnder1000(n: number): string {
  if (n < 100) return enUnder100(n)
  const hundreds = Math.floor(n / 100)
  const rem = n % 100
  const base = `${EN_ONES[hundreds]} hundred`
  return rem === 0 ? base : `${base} ${enUnder100(rem)}`
}

function enInteger(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  const negative = value < 0
  let n = Math.floor(Math.abs(value))
  if (n === 0) return negative ? "minus zero" : "zero"

  if (n >= 1e12) return String(value)
  const scales = ["", "thousand", "million", "billion"]
  const groups: number[] = []
  while (n > 0) {
    groups.push(n % 1000)
    n = Math.floor(n / 1000)
  }

  const parts: string[] = []
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!
    if (g === 0) continue
    parts.push(i === 0 ? enUnder1000(g) : `${enUnder1000(g)} ${scales[i]}`)
  }
  return `${negative ? "minus " : ""}${parts.join(" ")}`
}

/** Split a numeric literal into its integer digits and optional fraction. */
function splitNumeric(
  raw: string,
  locale: SpokenLocale
): {
  int: string
  frac?: string
} {
  const cleaned = raw.replace(/[\s\u00A0\u202F]/g, "")
  if (locale === "fr") {
    if (cleaned.includes(",")) {
      const [int, ...rest] = cleaned.split(",")
      return { int: int || "0", frac: rest.join("") || undefined }
    }
    if (cleaned.includes(".")) {
      // "1.234" reads as a grouped integer, "3.14" as a decimal.
      if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
        return { int: cleaned.replace(/\./g, "") }
      }
      const [int, ...rest] = cleaned.split(".")
      return { int: int || "0", frac: rest.join("") || undefined }
    }
    return { int: cleaned || "0" }
  }
  // English: comma groups thousands, dot is the decimal separator.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) {
    const [grouped, frac] = cleaned.replace(/,/g, "").split(".")
    return { int: grouped || "0", frac: frac || undefined }
  }
  if (cleaned.includes(".")) {
    const [int, ...rest] = cleaned.split(".")
    return { int: int || "0", frac: rest.join("") || undefined }
  }
  // A lone comma is accepted as a decimal comma (European input in English
  // prose) instead of producing NaN.
  if (cleaned.includes(",")) {
    const [int, ...rest] = cleaned.split(",")
    return { int: int || "0", frac: rest.join("") || undefined }
  }
  return { int: cleaned || "0" }
}

function digitsToWordsFr(digits: string): string {
  return digits
    .split("")
    .map(digit => FR_UNITS[Number(digit)]!)
    .join(" ")
}

function digitsToWordsEn(digits: string): string {
  return digits
    .split("")
    .map(digit => EN_ONES[Number(digit)]!)
    .join(" ")
}

function numberToWords(raw: string, locale: SpokenLocale): string {
  const { int, frac } = splitNumeric(raw, locale)
  const integer = Number(int)
  if (locale === "fr") {
    const spokenInt = frInteger(integer)
    if (!frac) return spokenInt
    const spokenFrac = frac.startsWith("0")
      ? digitsToWordsFr(frac)
      : frInteger(Number(frac))
    return `${spokenInt} virgule ${spokenFrac}`
  }
  const spokenInt = enInteger(integer)
  if (!frac) return spokenInt
  return `${spokenInt} point ${digitsToWordsEn(frac)}`
}

// ---------------------------------------------------------------------------
// Ordinals
// ---------------------------------------------------------------------------

function frOrdinal(value: number): string {
  if (value === 1) return "premier"
  const cardinal = frInteger(value)
  if (cardinal.endsWith("un")) return `${cardinal}ième`
  if (cardinal === "cinq") return "cinquième"
  if (cardinal === "neuf") return "neuvième"
  if (cardinal === "trois") return "troisième"
  if (cardinal.endsWith("s")) return `${cardinal.slice(0, -1)}ième`
  if (cardinal.endsWith("e")) return `${cardinal.slice(0, -1)}ième`
  return `${cardinal}ième`
}

const EN_ORDINAL_SMALL = [
  "zeroth",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
]

function enOrdinal(value: number): string {
  if (value < 20) return EN_ORDINAL_SMALL[value]!
  if (value >= 100) {
    const rem = value % 100
    if (rem === 0) return `${enUnder1000(value / 100)} hundredth`
    return `${enInteger(value - rem)} ${enOrdinal(rem)}`
  }
  const rem = value % 10
  if (rem === 0) {
    return `${EN_TENS[Math.floor(value / 10)]!.replace(/y$/, "ie")}th`
  }
  return `${enUnder100(value - rem)}-${EN_ORDINAL_SMALL[rem]}`
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

const FR_UNIT_WORDS: Record<string, [string, string]> = {
  "km/h": ["kilomètre par heure", "kilomètres par heure"],
  km: ["kilomètre", "kilomètres"],
  kg: ["kilogramme", "kilogrammes"],
  cm: ["centimètre", "centimètres"],
  mm: ["millimètre", "millimètres"],
  "m²": ["mètre carré", "mètres carrés"],
  m2: ["mètre carré", "mètres carrés"],
  "°c": ["degré Celsius", "degrés Celsius"],
  "°f": ["degré Fahrenheit", "degrés Fahrenheit"],
}

const EN_UNIT_WORDS: Record<string, [string, string]> = {
  "km/h": ["kilometre per hour", "kilometres per hour"],
  km: ["kilometre", "kilometres"],
  kg: ["kilogram", "kilograms"],
  cm: ["centimetre", "centimetres"],
  mm: ["millimetre", "millimetres"],
  "m²": ["square metre", "square metres"],
  m2: ["square metre", "square metres"],
  "°c": ["degree Celsius", "degrees Celsius"],
  "°f": ["degree Fahrenheit", "degrees Fahrenheit"],
}

function unitToWords(raw: string, unit: string, locale: SpokenLocale): string {
  const table = locale === "fr" ? FR_UNIT_WORDS : EN_UNIT_WORDS
  const words = table[unit.toLowerCase()]
  if (!words) return `${raw} ${unit}`
  const { int, frac } = splitNumeric(raw, locale)
  const isOne = !frac && Number(int) === 1
  return `${numberToWords(raw, locale)} ${isOne ? words[0] : words[1]}`
}

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

// A number literal: grouped thousands first ("1 234", "1,234"), then decimals.
const NUM_SOURCE = String.raw`(?:\d{1,3}(?:[\u00A0\u202F]\d{3})+(?:[.,]\d+)?|\d{1,3}(?:[ ]\d{3})+(?:[.,]\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)`

const SAFE_NUM_BEFORE = String.raw`(?<![\p{L}\p{N}_])`
const SAFE_NUM_AFTER = String.raw`(?![\p{L}\p{N}_])`

const FR_MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
]

const EN_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

function frTime(hour: number, minute?: number): string {
  const hours =
    hour === 1 ? "une heure" : `${frInteger(hour)} heures`
  if (minute === undefined || minute === 0) return hours
  return `${hours} ${frInteger(minute)}`
}

function enTime(hour: number, minute?: number): string {
  if (minute === undefined || minute === 0) return `${enInteger(hour)} o'clock`
  return `${enInteger(hour)} ${enInteger(minute)}`
}

function frDate(day: number, month: number, year?: string): string {
  const dayWords = day === 1 ? "premier" : frInteger(day)
  const monthWords = FR_MONTHS[month - 1] ?? frInteger(month)
  if (!year) return `${dayWords} ${monthWords}`
  return `${dayWords} ${monthWords} ${frInteger(Number(year))}`
}

function enDate(month: number, day: number, year?: string): string {
  const monthWords = EN_MONTHS[month - 1] ?? enInteger(month)
  const dayWords = enOrdinal(day)
  if (!year) return `${monthWords} ${dayWords}`
  return `${monthWords} ${dayWords} ${enInteger(Number(year))}`
}

function frMoney(raw: string): string {
  const { int, frac } = splitNumeric(raw, "fr")
  const euros = Number(int)
  const euroWord = euros === 1 ? "euro" : "euros"
  const intWords = frInteger(euros)
  if (!frac) return `${intWords} ${euroWord}`
  const cents = Number(frac.padEnd(2, "0").slice(0, 2))
  if (cents === 0) return `${intWords} ${euroWord}`
  return `${intWords} ${euroWord} ${frInteger(cents)} centimes`
}

function enMoney(raw: string, currency: "dollar" | "euro" | "pound"): string {
  const { int, frac } = splitNumeric(raw, "en")
  const amount = Number(int)
  const unit = amount === 1 ? currency : `${currency}s`
  const intWords = enInteger(amount)
  if (!frac) return `${intWords} ${unit}`
  const cents = Number(frac.padEnd(2, "0").slice(0, 2))
  if (cents === 0) return `${intWords} ${unit}`
  const centWord = currency === "euro" ? "cents" : "cents"
  return `${intWords} ${unit} ${enInteger(cents)} ${centWord}`
}

/**
 * Rewrite written-only forms in `text` to spoken words. Pure and idempotent:
 * it only matches digit/abbreviation patterns, so text already written in
 * words passes through unchanged.
 */
export function normalizeWrittenForms(
  text: string,
  locale: SpokenLocale = "fr"
): string {
  let out = text

  // Phone numbers, UUIDs and long pure-digit ids are never read aloud.
  // French national/mobile shape first (0X XX XX XX XX), then explicit
  // international numbers (+country...), then long bare digit runs (ids).
  out = out.replace(/(?<!\d)0[1-9](?:[\s.\-]?\d{2}){4}(?!\d)/g, " ")
  out = out.replace(/(?<!\d)\+\d{1,3}(?:[\s.\-]?\(?\d{1,4}\)?){2,}(?!\d)/g, " ")
  out = out.replace(/(?<!\d)\d{9,}(?!\d)/g, " ")
  out = out.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    " "
  )

  // Abbreviations first, so "n°7" becomes "numéro 7" and then "numéro sept".
  const abbreviations: Array<[RegExp, string]> =
    locale === "fr"
      ? [
          [/\bMlles\b\.?/g, "Mesdemoiselles"],
          [/\bMmes\b\.?/g, "Mesdames"],
          [/\bMM\.\s*/g, "Messieurs "],
          [/\bMlle\b\.?/g, "Mademoiselle"],
          [/\bMme\b\.?/g, "Madame"],
          [/\bM\.\s*/g, "Monsieur "],
          [/\bN°\s*/gi, "numéro "],
          [/\bc-à-d\b/gi, "c'est-à-dire"],
          [/\bcàd\b/gi, "c'est-à-dire"],
          [/\betc\./gi, "et cetera."],
          [/\betc\b/gi, "et cetera"],
          [/\bcf\.?/gi, "voir"],
          [/\benv\./gi, "environ"],
          [/\bDr\b\.?/g, "Docteur"],
          [/\bPr\b\.?/g, "Professeur"],
        ]
      : [
          [/\bMr\.?\s*/g, "Mister "],
          [/\bMrs\.?\s*/g, "Missus "],
          [/\bMs\.?\s*/g, "Miss "],
          [/\bDr\.?\s*/g, "Doctor "],
          [/\be\.g\./gi, "for example"],
          [/\bi\.e\./gi, "that is"],
          [/\bvs\.?/gi, "versus"],
          [/\betc\./gi, "et cetera."],
          [/\betc\b/gi, "et cetera"],
        ]
  for (const [pattern, replacement] of abbreviations) {
    out = out.replace(pattern, replacement)
  }

  // Times.
  if (locale === "fr") {
    out = out.replace(
      new RegExp(String.raw`\b(\d{1,2})\s*[hH]\s*(\d{2})\b`, "g"),
      (_m, h: string, min: string) => frTime(Number(h), Number(min))
    )
    out = out.replace(
      new RegExp(String.raw`\b(\d{1,2})\s*[hH]\b(?!\s*\d)`, "g"),
      (_m, h: string) => frTime(Number(h))
    )
  } else {
    out = out.replace(
      new RegExp(String.raw`\b(\d{1,2}):(\d{2})\b`, "g"),
      (_m, h: string, min: string) => enTime(Number(h), Number(min))
    )
  }

  // Dates. French is day/month(/year), English month/day(/year).
  if (locale === "fr") {
    out = out.replace(
      new RegExp(String.raw`\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b`, "g"),
      (m, d: string, mo: string, y: string) => {
        const day = Number(d)
        const month = Number(mo)
        return day >= 1 && day <= 31 && month >= 1 && month <= 12
          ? frDate(day, month, y)
          : m
      }
    )
    out = out.replace(
      new RegExp(String.raw`\b(\d{1,2})/(\d{1,2})\b`, "g"),
      (m, d: string, mo: string) => {
        const day = Number(d)
        const month = Number(mo)
        return day >= 1 && day <= 31 && month >= 1 && month <= 12
          ? frDate(day, month)
          : m
      }
    )
  } else {
    out = out.replace(
      new RegExp(String.raw`\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b`, "g"),
      (m, mo: string, d: string, y?: string) => {
        const month = Number(mo)
        const day = Number(d)
        return day >= 1 && day <= 31 && month >= 1 && month <= 12
          ? enDate(month, day, y)
          : m
      }
    )
  }

  // Money.
  if (locale === "fr") {
    out = out.replace(
      new RegExp(String.raw`(${NUM_SOURCE})\s*(?:euros?\b|EUR\b|€)`, "gi"),
      (_m, raw: string) => frMoney(raw)
    )
    out = out.replace(
      new RegExp(String.raw`€\s*(${NUM_SOURCE})`, "g"),
      (_m, raw: string) => frMoney(raw)
    )
  } else {
    out = out.replace(
      new RegExp(String.raw`\$\s*(${NUM_SOURCE})`, "g"),
      (_m, raw: string) => enMoney(raw, "dollar")
    )
    out = out.replace(
      new RegExp(String.raw`(${NUM_SOURCE})\s*(?:dollars?|USD)\b`, "gi"),
      (_m, raw: string) => enMoney(raw, "dollar")
    )
    out = out.replace(
      new RegExp(String.raw`(${NUM_SOURCE})\s*(?:euros?|EUR)\b`, "gi"),
      (_m, raw: string) => enMoney(raw, "euro")
    )
  }

  // Percentages.
  out = out.replace(
    new RegExp(String.raw`(${NUM_SOURCE})\s*%`, "g"),
    (_m, raw: string) =>
      `${numberToWords(raw, locale)} ${locale === "fr" ? "pour cent" : "percent"}`
  )

  // Units (only unambiguous ones).
  out = out.replace(
    new RegExp(
      String.raw`(${NUM_SOURCE})\s*(km\/h|km|kg|cm|mm|m²|m2|°C|°F)(?![A-Za-zÀ-ÿ0-9])`,
      "gi"
    ),
    (_m, raw: string, unit: string) => unitToWords(raw, unit, locale)
  )

  // Ordinals (before plain integers).
  if (locale === "fr") {
    out = out.replace(
      new RegExp(String.raw`\b(\d{1,3})\s*(?:ère|ere|ème|eme|er|re|e)\b`, "gi"),
      (_m, raw: string) => frOrdinal(Number(raw))
    )
  } else {
    out = out.replace(
      new RegExp(String.raw`\b(\d{1,3})(st|nd|rd|th)\b`, "gi"),
      (_m, raw: string) => enOrdinal(Number(raw))
    )
  }

  // Remaining integers and decimals.
  out = out.replace(
    new RegExp(
      String.raw`${SAFE_NUM_BEFORE}(${NUM_SOURCE})${SAFE_NUM_AFTER}`,
      "gu"
    ),
    (_m, raw: string) => numberToWords(raw, locale)
  )

  // Tidy whitespace and punctuation left behind by removed tokens.
  return out
    .replace(/\s+/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim()
}

/**
 * Normalize a chat-formatted reply into speakable prose before synthesis.
 * Strips the tokens, drops separator-only lines, and joins line fragments
 * into sentences so the note sounds like speech. Then rewrites digits,
 * dates, times, money, percentages, ordinals and common abbreviations to
 * spoken words in `locale` (French by default).
 */
export function toSpokenText(
  text: string,
  locale: SpokenLocale = "fr",
  options: ToSpokenTextOptions = {}
): string {
  const labels = (options.stripLabels ?? []).filter(l => l.length > 0)
  const labelSet = new Set(labels.map(bareSegment))
  const lines = text
    .split("\n")
    .map(line => (labelSet.size > 0 ? dropLabelSegments(line, labelSet) : line))
    .map(line =>
      line
        .replace(/https?:\/\/\S+/gi, " ") // URLs - never read a link aloud
        .replace(/[→←►▶◀•▪◦‣·]/g, " ") // arrow / bullet glyphs
        .replace(/\*\*|__|[*_~`#|]|^>\s?/g, " ") // markdown tokens
        .replace(/\p{Extended_Pictographic}|[️‍]/gu, "") // emojis
        .replace(/[^\S\u00A0\u202F]+/g, " ")
        .trim()
    )
    .filter(line => line.length > 0 && !/^[-=_.\s]+$/.test(line))
  // Join fragments with a sentence break so lines don't run together when
  // spoken; the final line keeps its own (possibly absent) punctuation.
  const joined = lines
    .map((line, i) =>
      i < lines.length - 1 && !/[.!?…:,;]$/.test(line) ? `${line}.` : line
    )
    .join(" ")
    .replace(/[^\S\u00A0\u202F]+/g, " ")
    .trim()
  // Drop host-declared labels that stand as a WHOLE segment of the flattened
  // text: anchored at string start or a sentence boundary (zero-width
  // lookbehind, so adjacent labels each match independently), a whole word,
  // and ended by a terminator or the end of the text. A label that merely
  // heads a longer phrase ("In writing this down...") is never touched.
  const withoutScaffold =
    labels.length === 0
      ? joined
      : joined
          .replace(
            new RegExp(
              `(?<=^|[.!?…\\n]\\s?)(?:${labels.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])(?:\\s*[.!?…]+\\s*|\\s*$)`,
              "giu"
            ),
            ""
          )
          .replace(/[^\S\u00A0\u202F]+/g, " ")
          .trim()
  if (!withoutScaffold) return ""

  return normalizeWrittenForms(withoutScaffold, locale)
}

/**
 * Split spoken text into voice-note-sized parts at SENTENCE boundaries only,
 * never mid-sentence, preserving order. Returns `null` when a single sentence
 * is longer than `maxChars` (the caller must shorten or fall back to text
 * instead of cutting it).
 */
export function splitSpokenText(
  text: string,
  maxChars: number
): string[] | null {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.length <= maxChars) return [trimmed]

  const sentences =
    trimmed.match(/[^.!?…]+[.!?…]+(?:\s+|$)|[^.!?…]+$/g)?.map(s => s.trim()) ??
    []
  const parts: string[] = []
  let current = ""
  for (const sentence of sentences) {
    if (!sentence) continue
    if (sentence.length > maxChars) return null
    const candidate = current ? `${current} ${sentence}` : sentence
    if (candidate.length > maxChars && current) {
      parts.push(current)
      current = sentence
    } else {
      current = candidate
    }
  }
  if (current) parts.push(current)
  return parts
}

/**
 * True iff the text carries content that only reads well as text - a code
 * fence or a markdown table separator (`|---|`). Even normalized, reading
 * such content aloud is nonsense: the caller should refuse synthesis and ask
 * for a short spoken summary instead, with details sent as text.
 */
export function hasWrittenOnlyContent(text: string): boolean {
  if (text.includes("```")) return true // code fence
  return /\|\s*:?-{2,}/.test(text) // markdown table separator
}

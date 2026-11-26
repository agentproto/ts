import { describe, it, expect } from "vitest"
import {
  toSpokenText,
  hasWrittenOnlyContent,
  splitSpokenText,
} from "../text/spoken-text"

describe("toSpokenText", () => {
  it("leaves plain spoken prose untouched", () => {
    const prose = "Coucou, ça va ? Moi oui."
    expect(toSpokenText(prose)).toBe(prose)
  })

  it("strips markdown, arrows and emojis; drops separator lines", () => {
    expect(toSpokenText("→ **Bonjour** → **teste** 🎙️\n---\nBravo !")).toBe(
      "Bonjour teste. Bravo !"
    )
  })

  it("strips host-declared labels wherever they land, keeps the content", () => {
    const stripLabels = ["Voice sent and written", "Voice sent", "In writing"]
    expect(
      toSpokenText(
        "Hello 💙\n→ **Voice sent** 🎙️\n---\n**In writing** 📝\n---\nSalad with chicken, well done.",
        "en",
        { stripLabels }
      )
    ).toBe("Hello. Salad with chicken, well done.")
    expect(
      toSpokenText("Hello. Voice sent. In writing. Salad with chicken.", "en", {
        stripLabels,
      })
    ).toBe("Hello. Salad with chicken.")
  })

  it("strips no label unless the host declares it", () => {
    expect(toSpokenText("Voice sent. Salad.", "en")).toBe("Voice sent. Salad.")
  })

  it("matches declared labels literally, never as a pattern", () => {
    expect(
      toSpokenText("Done (ok). Next step.", "en", { stripLabels: ["(ok)"] })
    ).toBe("Done (ok). Next step.")
    expect(
      toSpokenText("(ok). Next step.", "en", { stripLabels: ["(ok)"] })
    ).toBe("Next step.")
  })

  it("does NOT strip genuine spoken sentences that happen to start with 'Written'", () => {
    expect(
      toSpokenText("Written in 2024, the report shows clear progress.", "en")
    ).toBe(
      "Written in two thousand twenty-four, the report shows clear progress."
    )
    expect(
      toSpokenText("Voice sentence by sentence works.", "en", {
        stripLabels: ["Voice sent"],
      })
    ).toBe("Voice sentence by sentence works.")
  })

  it("strips URLs - never read a link aloud", () => {
    expect(toSpokenText("Regarde https://example.com/recette ça aide")).toBe(
      "Regarde ça aide"
    )
  })

  it("joins line fragments with sentence breaks", () => {
    expect(toSpokenText("Bonjour !\nTu vas bien\nMoi oui")).toBe(
      "Bonjour ! Tu vas bien. Moi oui"
    )
  })

  it("returns empty when nothing speakable remains", () => {
    expect(toSpokenText("→ ✅ 💙\n---\n***")).toBe("")
  })
})

describe("hasWrittenOnlyContent", () => {
  it("flags a code fence", () => {
    expect(hasWrittenOnlyContent("```js\nconsole.log(1)\n```")).toBe(true)
  })

  it("flags a markdown table separator", () => {
    expect(hasWrittenOnlyContent("| Aliment | Kcal |\n| --- | --- |")).toBe(
      true
    )
  })

  it("accepts plain prose", () => {
    expect(hasWrittenOnlyContent("Coucou, ça va ?")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Deterministic orality: digits, times, dates, money, percent, ordinals and
// common abbreviations are rewritten to spoken words in CODE (never delegated
// to the model). French first, English second. `toSpokenText(text, locale)`.
// ---------------------------------------------------------------------------

describe("toSpokenText - French deterministic orality", () => {
  const fr = (text: string) => toSpokenText(text, "fr")

  it("spells out integers across the French number scale", () => {
    expect(fr("J'ai 27 ans et 3 chats.")).toBe(
      "J'ai vingt-sept ans et trois chats."
    )
    expect(fr("0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16")).toBe(
      "zéro un deux trois quatre cinq six sept huit neuf dix onze douze treize quatorze quinze seize"
    )
    expect(fr("17 18 19 20 21 71 80 81 90")).toBe(
      "dix-sept dix-huit dix-neuf vingt vingt et un soixante et onze quatre-vingts quatre-vingt-un quatre-vingt-dix"
    )
    expect(fr("100, 200, 201, 1000, 2000, 1000000")).toBe(
      "cent, deux cents, deux cent un, mille, deux mille, un million"
    )
  })

  it("spells out decimals", () => {
    expect(fr("12,5 et 3.14")).toBe(
      "douze virgule cinq et trois virgule quatorze"
    )
    expect(fr("1,05")).toBe("un virgule zéro cinq")
  })

  it("spells out times (14h30, 9h05, 14h)", () => {
    expect(fr("à 14h30 et 9h05, puis 14h")).toBe(
      "à quatorze heures trente et neuf heures cinq, puis quatorze heures"
    )
  })

  it("spells out dates (15/05, 15/05/2026) and days", () => {
    expect(fr("le 15/05 et le 15/05/2026")).toBe(
      "le quinze mai et le quinze mai deux mille vingt-six"
    )
    expect(fr("le 1er mai et le 2e étage")).toBe(
      "le premier mai et le deuxième étage"
    )
  })

  it("spells out money (20 €, €20, 12,50 euros)", () => {
    expect(fr("20 €, €20 et 12,50 euros")).toBe(
      "vingt euros, vingt euros et douze euros cinquante centimes"
    )
    expect(fr("1 €")).toBe("un euro")
  })

  it("spells out percentages", () => {
    expect(fr("90 % de réussite et 12,5 %")).toBe(
      "quatre-vingt-dix pour cent de réussite et douze virgule cinq pour cent"
    )
  })

  it("spells out common units only when unambiguous", () => {
    expect(fr("5 kg, 15 °C et 3 km")).toBe(
      "cinq kilogrammes, quinze degrés Celsius et trois kilomètres"
    )
    expect(fr("1 kg")).toBe("un kilogramme")
  })

  it("expands common abbreviations", () => {
    expect(fr("M. Dupont, Mme Martin, n°7, c-à-d, etc.")).toBe(
      "Monsieur Dupont, Madame Martin, numéro sept, c'est-à-dire, et cetera."
    )
  })

  it("leaves phone numbers, URLs and long ids out of the spoken text", () => {
    expect(fr("Appelle le 06 12 34 56 78 ou https://x.com/abc.")).toBe(
      "Appelle le ou"
    )
    expect(fr("Le colis 123456789 est arrivé.")).toBe("Le colis est arrivé.")
  })

  it("keeps space-grouped thousands (regular, NBSP and narrow NBSP)", () => {
    expect(fr("Ça coûte 1 000 euros.")).toBe("Ça coûte mille euros.")
    expect(fr("2 500 habitants")).toBe("deux mille cinq cents habitants")
    expect(fr("12 500 €")).toBe("douze mille cinq cents euros")
    expect(fr("100 000 euros")).toBe("cent mille euros")
    expect(fr("123 456 habitants")).toBe(
      "cent vingt-trois mille quatre cent cinquante-six habitants"
    )
    expect(fr("1\u00A0000 euros")).toBe("mille euros")
    expect(fr("1\u202F000 euros")).toBe("mille euros")
  })

  it("is idempotent and does not touch numbers already written in words", () => {
    const once = fr("J'ai 27 ans à 14h30, le 15/05.")
    expect(fr(once)).toBe(once)
    expect(fr("dix-sept et vingt et un")).toBe("dix-sept et vingt et un")
  })
})

describe("toSpokenText - English deterministic orality", () => {
  const en = (text: string) => toSpokenText(text, "en")

  it("spells out integers, decimals, time, percent and money", () => {
    expect(en("I have 27 cats and 3 dogs.")).toBe(
      "I have twenty-seven cats and three dogs."
    )
    expect(en("3.14")).toBe("three point one four")
    expect(en("at 14:30")).toBe("at fourteen thirty")
    expect(en("90% done")).toBe("ninety percent done")
    expect(en("$20 and 12.50 dollars")).toBe(
      "twenty dollars and twelve dollars fifty cents"
    )
  })

  it("handles grouped thousands and grouped currency", () => {
    expect(en("1,234,567")).toBe(
      "one million two hundred thirty-four thousand five hundred sixty-seven"
    )
    expect(en("$1,234.50")).toBe(
      "one thousand two hundred thirty-four dollars fifty cents"
    )
    expect(en("12,50 euros")).toBe("twelve euros fifty cents")
  })

  it("handles ordinals above ninety-nine", () => {
    expect(en("100th anniversary")).toBe("one hundredth anniversary")
    expect(en("110th")).toBe("one hundred tenth")
  })

  it("spells out ordinals and abbreviations", () => {
    expect(en("1st 2nd 3rd 4th")).toBe("first second third fourth")
    expect(en("Mr. Smith etc.")).toBe("Mister Smith et cetera.")
  })
})

describe("splitSpokenText", () => {
  it("keeps a short reply as one part", () => {
    expect(splitSpokenText("Bonjour. Ça va ?", 100)).toEqual([
      "Bonjour. Ça va ?",
    ])
  })

  it("splits at sentence boundaries only, in order", () => {
    const text =
      "Première phrase assez longue. Deuxième phrase assez longue. Troisième."
    const parts = splitSpokenText(text, 32)
    expect(parts).toEqual([
      "Première phrase assez longue.",
      "Deuxième phrase assez longue.",
      "Troisième.",
    ])
    expect(parts!.join(" ")).toBe(text)
  })

  it("returns null when a single sentence cannot fit (never cut mid-sentence)", () => {
    const sentence = "a".repeat(80) + "."
    expect(splitSpokenText(sentence, 40)).toBeNull()
  })
})

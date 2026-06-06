import { describe, it, expect } from "vitest"
import { normalizeLanguageTag } from "../language.js"

describe("normalizeLanguageTag", () => {
  it("maps a full English name to a code (Whisper verbose_json path)", () => {
    expect(normalizeLanguageTag("english")).toBe("en")
    expect(normalizeLanguageTag("French")).toBe("fr")
  })

  it("canonicalizes BCP-47 case (the <html lang> bug)", () => {
    expect(normalizeLanguageTag("en-us")).toBe("en-US")
    expect(normalizeLanguageTag("EN-gb")).toBe("en-GB")
    expect(normalizeLanguageTag("FR")).toBe("fr")
  })

  it("accepts underscore-delimited POSIX locales", () => {
    expect(normalizeLanguageTag("pt_BR")).toBe("pt-BR")
    expect(normalizeLanguageTag("de_de")).toBe("de-DE")
  })

  it("drops script subtags rather than truncating them as a region", () => {
    expect(normalizeLanguageTag("zh-Hant")).toBe("zh") // Hant is not a region
    expect(normalizeLanguageTag("zh-Hant-TW")).toBe("zh-TW")
  })

  it("omits (undefined) anything unparseable, never an invalid tag", () => {
    expect(normalizeLanguageTag("c++")).toBeUndefined()
    expect(normalizeLanguageTag("eng")).toBeUndefined() // 3-letter primary not in AIP-10 source schema
    expect(normalizeLanguageTag("")).toBeUndefined()
    expect(normalizeLanguageTag(undefined)).toBeUndefined()
  })
})

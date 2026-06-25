/**
 * Unit tests for `buildDistillPrompt` lang option.
 * Verifies the language instruction changes with --lang, and defaults to EN.
 */

import { describe, it, expect } from "vitest"
import { buildDistillPrompt } from "../prompt.js"

const INPUT = {
  title: "Introduction au RAG",
  body: "Le RAG combine retrieval et génération pour réduire les hallucinations.",
}

describe("buildDistillPrompt — lang option", () => {
  it("defaults to ENGLISH when no lang is provided", () => {
    const p = buildDistillPrompt(INPUT, 5)
    expect(p).toContain("in ENGLISH")
    expect(p).not.toContain("in FRENCH")
  })

  it("defaults to ENGLISH when lang is undefined explicitly", () => {
    const p = buildDistillPrompt(INPUT, 5, {})
    expect(p).toContain("in ENGLISH")
  })

  it("uses FRENCH when lang=fr", () => {
    const p = buildDistillPrompt(INPUT, 5, { lang: "fr" })
    expect(p).toContain("in FRENCH")
    expect(p).not.toContain("in ENGLISH")
  })

  it("uses GERMAN when lang=de", () => {
    const p = buildDistillPrompt(INPUT, 5, { lang: "de" })
    expect(p).toContain("in GERMAN")
  })

  it("uses SPANISH when lang=es", () => {
    const p = buildDistillPrompt(INPUT, 5, { lang: "es" })
    expect(p).toContain("in SPANISH")
  })

  it("uppercases unknown lang codes as-is", () => {
    const p = buildDistillPrompt(INPUT, 5, { lang: "br" })
    expect(p).toContain("in BR")
  })

  it("lang is case-insensitive (FR → FRENCH)", () => {
    const p = buildDistillPrompt(INPUT, 5, { lang: "FR" })
    expect(p).toContain("in FRENCH")
  })

  it("still contains the Translate instruction regardless of lang", () => {
    for (const lang of [undefined, "fr", "de"]) {
      const p = buildDistillPrompt(INPUT, 5, lang ? { lang } : undefined)
      expect(p).toContain("Translate the insight")
    }
  })

  it("includes source title and body regardless of lang", () => {
    const p = buildDistillPrompt(INPUT, 5, { lang: "fr" })
    expect(p).toContain("Introduction au RAG")
    expect(p).toContain("Le RAG combine retrieval")
  })
})

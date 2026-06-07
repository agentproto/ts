import { describe, it, expect } from "vitest"
import { entriesToPersona, type CharacterEntry } from "../synth/footprint-to-persona.js"
import { parseCharacterItems } from "../distill/character.profile.js"

const entries: CharacterEntry[] = [
  {
    kind: "summary",
    title: "Terse, imperative builder voice",
    body: 'Speaks in short imperatives. Repeats "ship daily" and "compounding beats intensity".',
    tags: ["character", "voice", "building"],
  },
  { kind: "principle", title: "Distribution is the moat", body: "Believes distribution beats product.", tags: ["character", "growth"] },
  { kind: "pattern", title: "Posts build logs", body: "Posts daily progress threads.", tags: ["character", "building"] },
  { kind: "critique", title: "Hates vanity metrics", body: "Pushes back on follower-count flexing.", tags: ["character", "growth"] },
  { kind: "example", title: "Hit $10k MRR in 90 days", body: "Shared the milestone openly.", tags: ["character"] },
]

describe("entriesToPersona", () => {
  it("synthesizes a persona/v1 shell with voice + boundaries + lore", () => {
    const p = entriesToPersona(entries, { platform: "x", handle: "romanbuildsaas", name: "Roman", bio: "Building in public" })
    expect(p.schema).toBe("persona/v1")
    expect(p.name).toBe("char-romanbuildsaas")
    expect(p.title).toBe("Roman")
    // signature phrases extracted from quoted segments
    expect(p.voice?.signaturePhrases).toContain("ship daily")
    expect(p.voice?.signaturePhrases).toContain("compounding beats intensity")
    // boundaries from critiques
    expect(p.boundaries?.refuses).toContain("Hates vanity metrics")
    // lore from examples
    expect(p.backstory?.background).toContain("10k MRR")
    // tonality = the voice-summary descriptor (its title), not tag slugs
    expect(p.voice?.tonality).toContain("Terse, imperative builder voice")
    expect(p.voice?.tonality).not.toContain("character")
    // archetypes intentionally omitted (tags are not character archetypes)
    expect(p.backstory?.archetypes).toBeUndefined()
  })

  it("does not capture across contractions in single-quoted phrases", () => {
    const tricky: CharacterEntry[] = [
      {
        kind: "summary",
        title: "Voice: honest builder",
        body: `Roman's awareness shows — "I don't open with a pitch" is his rule.`,
        tags: ["character"],
      },
    ]
    const p = entriesToPersona(tricky, { platform: "x", handle: "r" })
    expect(p.voice?.signaturePhrases).toContain("I don't open with a pitch")
    // the contraction span must NOT become a phrase
    expect(
      (p.voice?.signaturePhrases ?? []).some((s) => s.includes("awareness"))
    ).toBe(false)
    // "Voice:" label stripped from the tonality descriptor
    expect(p.voice?.tonality).toContain("honest builder")
  })

  it("is deterministic", () => {
    const a = entriesToPersona(entries, { platform: "x", handle: "r" })
    const b = entriesToPersona(entries, { platform: "x", handle: "r" })
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
  })
})

describe("parseCharacterItems", () => {
  it("parses a fenced JSON array and tags every item 'character'", () => {
    const text = '```json\n[{"kind":"principle","title":"X","body":"Y","tags":["growth"]}]\n```'
    const items = parseCharacterItems(text)
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe("principle")
    expect(items[0]!.tags).toContain("character")
    expect(items[0]!.tags).toContain("growth")
  })

  it("rejects malformed / unknown kinds", () => {
    expect(parseCharacterItems("no array here")).toHaveLength(0)
    expect(parseCharacterItems('[{"kind":"bogus","title":"a","body":"b"}]')).toHaveLength(0)
  })
})

/**
 * Baseline tests — app shell behaviour.
 */

import { describe, it, expect } from "vitest"
import {
  createRiftApp,
  createInitialState,
  validateInput,
  validateCard,
} from "../app.js"
import { MOCK_CARD, MOCK_CARDS } from "../mock-data.js"

// ─── createInitialState ─────────────────────────────────────────────

describe("createInitialState", () => {
  it("returns an empty state with loading status", () => {
    const s = createInitialState()
    expect(s.cards).toEqual([])
    expect(s.activeCardStatus).toBe("loading")
    expect(s.activeCardIndex).toBe(-1)
  })
})

// ─── createRiftApp — core CRUD ─────────────────────────────────────

describe("createRiftApp", () => {
  it("starts with zero cards", () => {
    const app = createRiftApp()
    expect(app.cardCount()).toBe(0)
    expect(app.activeCard()).toBeUndefined()
  })

  it("addCard appends and sets active", () => {
    const app = createRiftApp()
    app.addCard(MOCK_CARD)
    expect(app.cardCount()).toBe(1)
    expect(app.activeCard()?.id).toBe(MOCK_CARD.id)
    expect(app.getState().activeCardIndex).toBe(0)
    expect(app.getState().activeCardStatus).toBe("ready")
  })

  it("setActive navigates to a valid index", () => {
    const app = createRiftApp()
    app.loadCards(MOCK_CARDS)
    expect(app.setActive(0)).toBe(true)
    expect(app.activeCard()?.id).toBe(MOCK_CARDS[0].id)
  })

  it("setActive rejects out-of-range index", () => {
    const app = createRiftApp()
    app.loadCards(MOCK_CARDS)
    expect(app.setActive(999)).toBe(false)
    expect(app.setActive(-1)).toBe(false)
  })

  it("loadCards replaces existing cards", () => {
    const app = createRiftApp()
    app.addCard(MOCK_CARD)
    expect(app.cardCount()).toBe(1)

    app.loadCards([])
    expect(app.cardCount()).toBe(0)
    expect(app.activeCard()).toBeUndefined()
  })

  it("loadCards with non-empty array sets activeCardIndex to 0", () => {
    const app = createRiftApp()
    app.loadCards(MOCK_CARDS)
    expect(app.getState().activeCardIndex).toBe(0)
    expect(app.getState().activeCardStatus).toBe("ready")
  })

  it("loadCards with empty array sets activeCardIndex to -1 and status to loading", () => {
    const app = createRiftApp()
    app.loadCards([])
    expect(app.getState().activeCardIndex).toBe(-1)
    expect(app.getState().activeCardStatus).toBe("loading")
  })

  it("getState returns a snapshot (copy), not the live reference", () => {
    const app = createRiftApp()
    app.addCard(MOCK_CARD)
    const s1 = app.getState()
    app.addCard({ ...MOCK_CARD, id: "second" })
    const s2 = app.getState()
    expect(s1.cards.length).toBe(1)
    expect(s2.cards.length).toBe(2)
  })

  it("setStatus updates the active card status", () => {
    const app = createRiftApp()
    app.loadCards(MOCK_CARDS)
    app.setStatus("error")
    expect(app.getState().activeCardStatus).toBe("error")
  })
})

// ─── validateInput ──────────────────────────────────────────────────

describe("validateInput", () => {
  it("returns null for valid input", () => {
    expect(validateInput(MOCK_CARD.input)).toBeNull()
  })

  it("rejects non-objects", () => {
    expect(validateInput(null)).toBe("Input must be an object")
    expect(validateInput("hello")).toBe("Input must be an object")
    expect(validateInput(42)).toBe("Input must be an object")
  })

  it("rejects missing rawText", () => {
    expect(validateInput({})).toBe("rawText must be a non-empty string")
  })

  it("rejects empty rawText", () => {
    expect(validateInput({ rawText: "   " })).toBe(
      "rawText must be a non-empty string",
    )
  })
})

// ─── validateCard ───────────────────────────────────────────────────

describe("validateCard", () => {
  it("returns null for valid card", () => {
    expect(validateCard(MOCK_CARD)).toBeNull()
  })

  it("rejects non-objects", () => {
    expect(validateCard(null)).toBe("Card must be an object")
    expect(validateCard(undefined)).toBe("Card must be an object")
  })

  it("rejects missing id", () => {
    expect(validateCard({ claims: [], sources: [], createdAt: "", updatedAt: "" })).toBe(
      "id must be a non-empty string",
    )
  })

  it("rejects non-array claims", () => {
    expect(
      validateCard({ id: "x", claims: "nope", sources: [], createdAt: "", updatedAt: "" }),
    ).toBe("claims must be an array")
  })

  it("rejects non-array sources", () => {
    expect(
      validateCard({ id: "x", claims: [], sources: "nope", createdAt: "", updatedAt: "" }),
    ).toBe("sources must be an array")
  })

  it("rejects missing createdAt", () => {
    expect(
      validateCard({ id: "x", claims: [], sources: [], updatedAt: "" }),
    ).toBe("createdAt must be an ISO string")
  })
})

// ─── Full round-trip ────────────────────────────────────────────────

describe("full round-trip", () => {
  it("load → activeCard → validate produces a valid card", () => {
    const app = createRiftApp()
    app.loadCards(MOCK_CARDS)
    const card = app.activeCard()
    expect(card).toBeDefined()
    expect(validateCard(card)).toBeNull()
  })
})

/**
 * Rift app shell.
 *
 * A thin, framework-agnostic state container for Rift Cards. It owns the
 * active-card index, card-status lifecycle, and deterministic card
 * loading. It does NOT implement the full UI, research pipeline, or
 * evidence-quality gate — those arrive in later PRs.
 */

import type {
  RiftCard,
  RiftInput,
  RiftAppState,
  CardStatus,
} from "./types.js"

// ─── Factory ────────────────────────────────────────────────────────

export function createInitialState(): RiftAppState {
  return {
    cards: [],
    activeCardStatus: "loading",
    activeCardIndex: -1,
  }
}

// ─── Shell ──────────────────────────────────────────────────────────

export interface RiftApp {
  /** Immutable snapshot of current state. */
  getState(): Readonly<RiftAppState>
  /** Append a card and set it as active. */
  addCard(card: RiftCard): void
  /** Navigate to a card by index. Returns false if out of range. */
  setActive(index: number): boolean
  /** Set the status of the active card slot. */
  setStatus(status: CardStatus): void
  /** Return the active card, or undefined when empty. */
  activeCard(): RiftCard | undefined
  /** Total number of loaded cards. */
  cardCount(): number
  /** Load a batch of cards (replaces current list). */
  loadCards(cards: readonly RiftCard[]): void
}

export function createRiftApp(): RiftApp {
  let state = createInitialState()

  function snapshot(): RiftAppState {
    return {
      cards: [...state.cards],
      activeCardStatus: state.activeCardStatus,
      activeCardIndex: state.activeCardIndex,
    }
  }

  return {
    getState: snapshot,

    addCard(card: RiftCard) {
      state = {
        ...state,
        cards: [...state.cards, card],
        activeCardIndex: state.cards.length,
        activeCardStatus: "ready",
      }
    },

    setActive(index: number): boolean {
      if (index < 0 || index >= state.cards.length) return false
      state = {
        ...state,
        activeCardIndex: index,
        activeCardStatus: "ready",
      }
      return true
    },

    setStatus(status: CardStatus) {
      state = { ...state, activeCardStatus: status }
    },

    activeCard(): RiftCard | undefined {
      if (state.activeCardIndex < 0) return undefined
      return state.cards[state.activeCardIndex]
    },

    cardCount(): number {
      return state.cards.length
    },

    loadCards(cards: readonly RiftCard[]) {
      state = {
        cards: [...cards],
        activeCardIndex: cards.length > 0 ? 0 : -1,
        activeCardStatus: cards.length > 0 ? "ready" : "loading",
      }
    },
  }
}

// ─── Validation helpers ─────────────────────────────────────────────

/**
 * Minimal structural validation of a RiftInput — ensures rawText is
 * non-empty. Returns an error string or null when valid.
 */
export function validateInput(input: unknown): string | null {
  if (input === null || typeof input !== "object") return "Input must be an object"
  const obj = input as Record<string, unknown>
  if (typeof obj.rawText !== "string" || obj.rawText.trim().length === 0) {
    return "rawText must be a non-empty string"
  }
  return null
}

/**
 * Minimal structural validation of a RiftCard — ensures id, input,
 * claims array, and sources array are present. Returns an error string
 * or null when valid.
 */
export function validateCard(card: unknown): string | null {
  if (card === null || typeof card !== "object") return "Card must be an object"
  const obj = card as Record<string, unknown>
  if (typeof obj.id !== "string" || obj.id.length === 0) return "id must be a non-empty string"
  if (!Array.isArray(obj.claims)) return "claims must be an array"
  if (!Array.isArray(obj.sources)) return "sources must be an array"
  if (typeof obj.createdAt !== "string") return "createdAt must be an ISO string"
  if (typeof obj.updatedAt !== "string") return "updatedAt must be an ISO string"
  return null
}

/**
 * Deterministic mock data for the Rift demo.
 *
 * Every object is a plain literal — no randomness, no network, no model
 * calls. This module provides fixture-free structural placeholders only;
 * it must not contain fabricated research citations, metrics, or
 * attributions.
 */

import type {
  RiftInput,
  RiftCard,
  Source,
  Claim,
  GeneratedDrafts,
} from "./types.js"

// ─── Fixture-free placeholder card ──────────────────────────────────

export const MOCK_INPUT: RiftInput = {
  rawText:
    "AI agent orchestration runtimes are consolidating around open protocols.",
  title: "Placeholder input",
  tags: ["placeholder"],
}

export const MOCK_CLAIMS: readonly Claim[] = []

export const SOURCES: readonly Source[] = []

export const MOCK_DRAFTS: GeneratedDrafts = {
  prd: { placeholder: true },
  landingPage: { placeholder: true },
  xPost: { placeholder: true },
}

export const MOCK_CARD: RiftCard = {
  id: "rift-card-placeholder",
  input: MOCK_INPUT,
  claims: [],
  sources: [],
  marketSignal: "unclear",
  recommendation: {
    recommendation: "wait",
    reasons: [
      "No research evidence available yet.",
    ],
  },
  drafts: { ...MOCK_DRAFTS },
  createdAt: "2025-07-15T10:00:00.000Z",
  updatedAt: "2025-07-15T10:00:00.000Z",
}

export const MOCK_CARDS: readonly RiftCard[] = [MOCK_CARD]

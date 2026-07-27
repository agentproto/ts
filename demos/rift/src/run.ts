/**
 * Local runner — deterministic demo entry point.
 *
 * Usage:  pnpm dev   (from demos/rift/)
 *
 * Loads mock data, creates the app shell, feeds the card in, and
 * prints the resulting state to stdout. No network or model calls.
 */

import { createRiftApp } from "./app.js"
import { MOCK_CARDS } from "./mock-data.js"

const app = createRiftApp()

app.loadCards(MOCK_CARDS)

console.log("── Rift Demo ──")
console.log(`Cards loaded: ${app.cardCount()}`)
console.log(`Active index: ${app.getState().activeCardIndex}`)
console.log()

const card = app.activeCard()
if (card) {
  console.log(`Card ID   : ${card.id}`)
  console.log(`Title     : ${card.input.title ?? "(untitled)"}`)
  console.log(`Claims    : ${card.claims.length}`)
  console.log(`Sources   : ${card.sources.length}`)
  console.log(`Signal    : ${card.marketSignal ?? "—"}`)
  console.log(`Decision  : ${card.recommendation?.recommendation ?? "—"}`)
  console.log(`Created   : ${card.createdAt}`)
}

console.log()
console.log("Done.")

/**
 * DRIFT CHECK (intentionally data-dependent). Unlike the rest of the suite,
 * this one reads the real synced roster: when OpenAI retires a model the
 * curated overlay still claims, it must go red so the overlay moves with the
 * provider. The Catalog Sync workflow runs `*.drift.test.ts` separately and
 * reports a failure in the sync PR description instead of aborting the run.
 */
import { describe, it, expect } from "vitest"

import { OPENAI_LIVE_MODEL_IDS } from "../audio/live.js"
import { AUDIO_MODEL_CATALOG } from "../audio/catalog.js"

describe("curated overlay ↔ synced roster drift", () => {
  it("curated OpenAI s2s engines exist on the synced provider roster", () => {
    // Anti-drift: a hand-curated live engine must never reference an id
    // OpenAI's own /v1/models no longer serves. When OpenAI retires one,
    // the weekly sync drops it from the roster and this test goes red —
    // forcing the curated overlay to move with the provider.
    const curatedOpenAIS2S = Object.values(AUDIO_MODEL_CATALOG).filter(
      m => m.provider === "openai" && m.capabilities.s2s,
    )
    expect(curatedOpenAIS2S.length).toBeGreaterThanOrEqual(6)
    for (const m of curatedOpenAIS2S) {
      expect(OPENAI_LIVE_MODEL_IDS, `curated id ${m.providerId} not on /v1/models`).toContain(
        m.providerId,
      )
    }
  })

})

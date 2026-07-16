import { describe, expect, it } from "vitest"

import { interpretStopChoice, STOP_AND_SILENCE_BUTTON, STOP_BUTTON } from "./stopConfirm.logic.js"

describe("interpretStopChoice", () => {
  it("stops without silencing when the user clicks Stop", () => {
    expect(interpretStopChoice(STOP_BUTTON)).toEqual({ stop: true, silence: false })
  })

  it("stops and silences when the user clicks Stop and don't ask again", () => {
    expect(interpretStopChoice(STOP_AND_SILENCE_BUTTON)).toEqual({ stop: true, silence: true })
  })

  it("does nothing when the dialog is dismissed (Escape returns undefined)", () => {
    expect(interpretStopChoice(undefined)).toEqual({ stop: false, silence: false })
  })

  it("does nothing for the implicit modal Cancel button", () => {
    expect(interpretStopChoice("Cancel")).toEqual({ stop: false, silence: false })
  })

  it("does nothing for an unrecognised label rather than defaulting to stop", () => {
    expect(interpretStopChoice("garbage")).toEqual({ stop: false, silence: false })
  })
})

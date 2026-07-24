import { describe, expect, it } from "vitest"

import type { LlmEndpointDescriptorResult } from "../client/types.js"
import {
  localRouterErrorMessage,
  startLlmEndpointMessage,
  stopLlmEndpointMessage,
} from "./localRouter.logic.js"

function desc(over: Partial<LlmEndpointDescriptorResult> = {}): LlmEndpointDescriptorResult {
  return {
    pid: 4242,
    port: 18090,
    baseUrl: "http://localhost:18090",
    status: "running",
    startedAt: "2026-07-24T10:00:00.000Z",
    ...over,
  }
}

describe("startLlmEndpointMessage", () => {
  it("names the port on a fresh spawn", () => {
    expect(startLlmEndpointMessage(desc({ port: 18090 }))).toBe("Started Local Router on :18090.")
  })

  it("distinguishes an idempotent already-running no-op", () => {
    expect(startLlmEndpointMessage(desc({ port: 9000, wasAlreadyRunning: true }))).toBe(
      "Local Router already running on :9000.",
    )
  })
})

describe("stopLlmEndpointMessage", () => {
  it("is a fixed confirmation string", () => {
    expect(stopLlmEndpointMessage()).toBe("Stopped the Local Router.")
  })
})

describe("localRouterErrorMessage", () => {
  it("folds an Error's message into the start/stop verb", () => {
    expect(localRouterErrorMessage("start", new Error("boom"))).toBe(
      "Could not start the Local Router: boom",
    )
    expect(localRouterErrorMessage("stop", new Error("nope"))).toBe(
      "Could not stop the Local Router: nope",
    )
  })

  it("stringifies a non-Error rejection", () => {
    expect(localRouterErrorMessage("start", "raw")).toBe("Could not start the Local Router: raw")
  })
})

import { describe, expect, it } from "vitest"

import { isWebviewMessage } from "./protocol.js"

describe("isWebviewMessage", () => {
  it("accepts ready", () => {
    expect(isWebviewMessage({ type: "ready" })).toBe(true)
  })

  it("accepts kill", () => {
    // kill went with the composer button — see WebviewMessage.
    expect(isWebviewMessage({ type: "kill" })).toBe(false)
  })

  it("accepts send with text", () => {
    expect(isWebviewMessage({ type: "send", text: "hello" })).toBe(true)
  })

  it("accepts interruptSend with text", () => {
    expect(isWebviewMessage({ type: "interruptSend", text: "now" })).toBe(true)
  })

  it("rejects send without text", () => {
    expect(isWebviewMessage({ type: "send" })).toBe(false)
  })

  it("rejects send with non-string text", () => {
    expect(isWebviewMessage({ type: "send", text: 123 })).toBe(false)
  })

  it("rejects unknown types", () => {
    expect(isWebviewMessage({ type: "unknown" })).toBe(false)
  })

  it("rejects non-objects", () => {
    expect(isWebviewMessage(null)).toBe(false)
    expect(isWebviewMessage("ready")).toBe(false)
    expect(isWebviewMessage(42)).toBe(false)
  })

  it("accepts openToolIo only with a known field", () => {
    expect(isWebviewMessage({ type: "openToolIo", segmentId: "tool-t1", field: "input" })).toBe(true)
    expect(isWebviewMessage({ type: "openToolIo", segmentId: "tool-t1", field: "output" })).toBe(true)
    // `field` indexes straight into the tool segment, so anything else is
    // refused at the boundary rather than silently resolving to undefined.
    expect(isWebviewMessage({ type: "openToolIo", segmentId: "tool-t1", field: "stdout" })).toBe(false)
    expect(isWebviewMessage({ type: "openToolIo", segmentId: "tool-t1" })).toBe(false)
    expect(isWebviewMessage({ type: "openToolIo", field: "input" })).toBe(false)
  })
})

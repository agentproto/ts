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

  it("accepts stop", () => {
    // stop is NOT kill — it cancels the in-flight turn and leaves the
    // session alive, which is exactly why it earns a button (see WebviewMessage).
    expect(isWebviewMessage({ type: "stop" })).toBe(true)
  })

  it("accepts restart", () => {
    // The composer's Restart button (shown only once exited) — targets this
    // panel's own session id, resolved host-side, not carried on the message.
    expect(isWebviewMessage({ type: "restart" })).toBe(true)
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

  it("accepts attachImage carrying real bytes (ArrayBuffer or a view)", () => {
    expect(isWebviewMessage({ type: "attachImage", bytes: new ArrayBuffer(4), mime: "image/png" })).toBe(true)
    expect(isWebviewMessage({ type: "attachImage", bytes: new Uint8Array([1, 2]), mime: "image/jpeg" })).toBe(true)
  })

  it("rejects attachImage whose bytes are base64 text — the exact thing that must not pass as bytes", () => {
    expect(isWebviewMessage({ type: "attachImage", bytes: "iVBORw0KGgo=", mime: "image/png" })).toBe(false)
    expect(isWebviewMessage({ type: "attachImage", bytes: [1, 2, 3], mime: "image/png" })).toBe(false)
    expect(isWebviewMessage({ type: "attachImage", bytes: new ArrayBuffer(4) })).toBe(false)
    expect(isWebviewMessage({ type: "attachImage", bytes: new ArrayBuffer(4), mime: 5 })).toBe(false)
  })

  it("accepts attachFile only with bytes, mime AND a name", () => {
    expect(isWebviewMessage({ type: "attachFile", bytes: new Uint8Array([1]), mime: "application/pdf", name: "x.pdf" })).toBe(true)
    expect(isWebviewMessage({ type: "attachFile", bytes: new Uint8Array([1]), mime: "application/pdf" })).toBe(false)
    expect(isWebviewMessage({ type: "attachFile", bytes: "nope", mime: "application/pdf", name: "x.pdf" })).toBe(false)
  })

  it("accepts requestMentions with a string query (empty is valid — the initial list)", () => {
    expect(isWebviewMessage({ type: "requestMentions", query: "" })).toBe(true)
    expect(isWebviewMessage({ type: "requestMentions", query: "src/" })).toBe(true)
    expect(isWebviewMessage({ type: "requestMentions", query: 5 })).toBe(false)
  })

  it("accepts openTerminal (header Terminal segment) with no payload", () => {
    expect(isWebviewMessage({ type: "openTerminal" })).toBe(true)
  })
})

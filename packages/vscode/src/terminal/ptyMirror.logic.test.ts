import { describe, expect, it } from "vitest"

import {
  PTY_RECONNECT_DELAYS_MS,
  decodePtyData,
  encodeInputFrame,
  encodeResizeFrame,
  parsePtyServerFrame,
  reconnectDelayMs,
  shouldReconnect,
} from "./ptyMirror.logic.js"

describe("parsePtyServerFrame", () => {
  it("parses a data frame", () => {
    expect(parsePtyServerFrame('{"kind":"data","b64":"aGVsbG8="}')).toEqual({
      kind: "data",
      b64: "aGVsbG8=",
    })
  })

  it("parses an exit frame without a signal", () => {
    expect(parsePtyServerFrame('{"kind":"exit","exitCode":0}')).toEqual({
      kind: "exit",
      exitCode: 0,
    })
  })

  it("parses an exit frame with a signal", () => {
    expect(parsePtyServerFrame('{"kind":"exit","exitCode":1,"signal":9}')).toEqual({
      kind: "exit",
      exitCode: 1,
      signal: 9,
    })
  })

  it("returns unknown for malformed JSON", () => {
    expect(parsePtyServerFrame("{not json")).toEqual({ kind: "unknown" })
  })

  it("returns unknown for a JSON array", () => {
    expect(parsePtyServerFrame("[1,2,3]")).toEqual({ kind: "unknown" })
  })

  it("returns unknown for null", () => {
    expect(parsePtyServerFrame("null")).toEqual({ kind: "unknown" })
  })

  it("returns unknown for an unrecognised kind", () => {
    expect(parsePtyServerFrame('{"kind":"pong"}')).toEqual({ kind: "unknown" })
  })

  it("returns unknown when data is missing b64", () => {
    expect(parsePtyServerFrame('{"kind":"data"}')).toEqual({ kind: "unknown" })
  })

  it("returns unknown when exit is missing exitCode", () => {
    expect(parsePtyServerFrame('{"kind":"exit"}')).toEqual({ kind: "unknown" })
  })
})

describe("decodePtyData", () => {
  it("base64-decodes to UTF-8 text", () => {
    expect(decodePtyData("aGVsbG8=")).toBe("hello")
  })

  it("round-trips ANSI escape bytes", () => {
    const original = "\x1b[36mhi\x1b[0m"
    const b64 = Buffer.from(original, "utf8").toString("base64")
    expect(decodePtyData(b64)).toBe(original)
  })
})

describe("encodeInputFrame", () => {
  it("wraps UTF-8 text as a base64 input frame", () => {
    expect(encodeInputFrame("hi")).toBe('{"kind":"input","b64":"aGk="}')
  })

  it("round-trips through decodePtyData's inverse (Buffer)", () => {
    const frame = JSON.parse(encodeInputFrame("é")) as { kind: string; b64: string }
    expect(Buffer.from(frame.b64, "base64").toString("utf8")).toBe("é")
  })
})

describe("encodeResizeFrame", () => {
  it("encodes cols/rows exactly", () => {
    expect(encodeResizeFrame(80, 24)).toBe('{"kind":"resize","cols":80,"rows":24}')
  })
})

describe("reconnectDelayMs / shouldReconnect", () => {
  it("PTY_RECONNECT_DELAYS_MS is the 1s/2s/4s/4s/4s CLI-matching schedule", () => {
    expect(PTY_RECONNECT_DELAYS_MS).toEqual([1_000, 2_000, 4_000, 4_000, 4_000])
  })

  it("returns the delay for each attempt within bounds", () => {
    expect(reconnectDelayMs(0)).toBe(1_000)
    expect(reconnectDelayMs(1)).toBe(2_000)
    expect(reconnectDelayMs(4)).toBe(4_000)
  })

  it("returns undefined once attempts are exhausted", () => {
    expect(reconnectDelayMs(5)).toBeUndefined()
    expect(reconnectDelayMs(100)).toBeUndefined()
  })

  it("reconnects on 1006 within the attempt budget", () => {
    expect(shouldReconnect(1006, 0)).toBe(true)
    expect(shouldReconnect(1006, 4)).toBe(true)
  })

  it("does not reconnect on 1006 once attempts are exhausted", () => {
    expect(shouldReconnect(1006, 5)).toBe(false)
  })

  it("does not reconnect on a clean close (1000)", () => {
    expect(shouldReconnect(1000, 0)).toBe(false)
  })

  it("does not reconnect on an app-level close (4xxx)", () => {
    expect(shouldReconnect(4000, 0)).toBe(false)
  })
})

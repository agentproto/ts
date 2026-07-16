import { describe, expect, it } from "vitest"

import {
  buildAttachmentName,
  isBinaryPayload,
  mimeToExtension,
  resolveAttachmentsCwd,
  toUint8,
} from "./attachments.logic.js"

describe("resolveAttachmentsCwd", () => {
  it("defaults to ~/.agentproto, NOT the session cwd (bytes must not litter the repo tree)", () => {
    expect(resolveAttachmentsCwd({}, "/Users/jane")).toBe("/Users/jane/.agentproto")
  })

  it("honours $AGENTPROTO_HOME so it matches the CLI's own home", () => {
    expect(resolveAttachmentsCwd({ AGENTPROTO_HOME: "/opt/ap" }, "/Users/jane")).toBe("/opt/ap")
  })

  it("ignores an empty $AGENTPROTO_HOME rather than resolving to a bare basename", () => {
    expect(resolveAttachmentsCwd({ AGENTPROTO_HOME: "" }, "/Users/jane")).toBe("/Users/jane/.agentproto")
  })
})

describe("mimeToExtension", () => {
  it("maps the common screenshot types", () => {
    expect(mimeToExtension("image/png")).toBe("png")
    expect(mimeToExtension("image/jpeg")).toBe("jpg")
    expect(mimeToExtension("image/gif")).toBe("gif")
    expect(mimeToExtension("image/webp")).toBe("webp")
    expect(mimeToExtension("image/svg+xml")).toBe("svg")
  })

  it("is case- and parameter-insensitive", () => {
    expect(mimeToExtension("IMAGE/PNG")).toBe("png")
    expect(mimeToExtension("image/png; charset=binary")).toBe("png")
  })

  it("derives an extension from an unknown subtype, stripping any suffix", () => {
    expect(mimeToExtension("image/x-portable-anymap")).toBe("xportableanymap")
    expect(mimeToExtension("image/vnd.foo+bar")).toBe("vndfoo")
  })

  it("falls back to bin when there is no usable subtype", () => {
    expect(mimeToExtension("")).toBe("bin")
    expect(mimeToExtension("image/")).toBe("bin")
  })
})

describe("buildAttachmentName", () => {
  it("formats a UTC, sortable paste name", () => {
    // 2026-07-16T09:05:03Z
    const date = new Date(Date.UTC(2026, 6, 16, 9, 5, 3))
    expect(buildAttachmentName("image/png", date, "a1b2")).toBe("paste-20260716-090503-a1b2.png")
  })

  it("carries the mime's extension, not always .png", () => {
    const date = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
    expect(buildAttachmentName("image/jpeg", date, "z9")).toBe("paste-20260101-000000-z9.jpg")
  })
})

describe("isBinaryPayload", () => {
  it("accepts an ArrayBuffer and any typed-array view over one", () => {
    expect(isBinaryPayload(new ArrayBuffer(4))).toBe(true)
    expect(isBinaryPayload(new Uint8Array([1, 2, 3]))).toBe(true)
    expect(isBinaryPayload(new DataView(new ArrayBuffer(2)))).toBe(true)
  })

  it("rejects everything else — a string of base64 is exactly what must not pass", () => {
    expect(isBinaryPayload("iVBORw0KGgo=")).toBe(false)
    expect(isBinaryPayload([1, 2, 3])).toBe(false)
    expect(isBinaryPayload(null)).toBe(false)
    expect(isBinaryPayload(undefined)).toBe(false)
  })
})

describe("toUint8", () => {
  it("wraps an ArrayBuffer whole", () => {
    const buf = new Uint8Array([9, 8, 7]).buffer
    expect([...toUint8(buf)]).toEqual([9, 8, 7])
  })

  it("wraps a view over its exact window, not the whole backing buffer", () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5])
    const view = new Uint8Array(backing.buffer, 2, 3) // [2,3,4]
    expect([...toUint8(view)]).toEqual([2, 3, 4])
  })
})

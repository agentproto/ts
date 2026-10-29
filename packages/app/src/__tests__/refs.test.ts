import { describe, expect, it } from "vitest"
import { refKey } from "../refs.js"

describe("refKey", () => {
  it("keys the AIP-54 ref forms as before", () => {
    expect(refKey("tool:a/b")).toBe("tool:a/b")
    expect(refKey({ ref: "@x/y" })).toBe("@x/y")
    expect(refKey({ file: "./t.md" })).toBe("./t.md")
    expect(refKey({ inline: { a: 1 } })).toBe('{"a":1}')
  })

  it("keys a structured server tool item by its server", () => {
    expect(refKey({ kind: "mcp", server: "github", allow: ["x"] })).toBe("mcp:github")
  })
})

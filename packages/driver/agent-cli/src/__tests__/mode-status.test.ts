import { describe, expect, it } from "vitest"
import { modeSchema } from "../schema.js"

// AIP-45 modes carry an honest support `status` (+ `status_note`) so an
// adapter can admit a declared mode is a measured no-op or not-yet-wired
// instead of silently accepting it. Both fields are optional (absent ⇒
// treated as "active") and the enum is closed. These assertions lock the
// zod validation path in step with the paired JSON Schema.
describe("modeSchema — status / status_note", () => {
  it("accepts a mode declaring status + status_note", () => {
    const parsed = modeSchema.parse({
      id: "lean",
      status: "noop",
      status_note: "measured no-op",
    })
    expect(parsed.status).toBe("noop")
    expect(parsed.status_note).toBe("measured no-op")
  })

  it("treats status / status_note as optional (absent parses fine)", () => {
    const parsed = modeSchema.parse({ id: "default" })
    expect(parsed.status).toBeUndefined()
    expect(parsed.status_note).toBeUndefined()
  })

  it("rejects an out-of-enum status value", () => {
    const result = modeSchema.safeParse({ id: "lean", status: "bogus" })
    expect(result.success).toBe(false)
  })
})

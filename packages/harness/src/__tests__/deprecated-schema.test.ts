import { describe, it, expect } from "vitest"
import { agentCliFrontmatterSchema } from "../schema.js"

const base = {
  name: "demo",
  id: "demo",
  description: "demo harness",
  version: "0.1.0",
  bin: "demo",
  install: [{ method: "npm", package: "demo", global: true }],
  version_check: { cmd: "demo --version", parse: "(\\d+\\.\\d+\\.\\d+)", range: ">=0.1.0", timeout_ms: 1000 },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
}

describe("manifest `deprecated`", () => {
  it("accepts replacedBy with an optional message", () => {
    const r = agentCliFrontmatterSchema.safeParse({
      ...base,
      deprecated: { replacedBy: "antigravity", message: "use it" },
    })
    expect(r.success).toBe(true)
  })

  it("rejects an invalid id, an empty message and unknown keys", () => {
    for (const deprecated of [
      { replacedBy: "Not Valid!" },
      { replacedBy: "antigravity", message: "" },
      { replacedBy: "antigravity", extra: true },
    ]) {
      expect(agentCliFrontmatterSchema.safeParse({ ...base, deprecated }).success).toBe(false)
    }
  })
})

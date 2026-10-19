/**
 * Contract tests: every fixture shape validates or rejects exactly as the
 * contract says it must, and every explicit schema behaviour is pinned
 * (state tolerance, passthrough preservation, version constant).
 */
import { describe, expect, it } from "vitest"
import {
  COMPUTER_API_VERSION,
  COMPUTER_STATES,
  computerStateSchema,
  computerStatusSchema,
  createComputerResponseSchema,
  portPublishSchema,
} from "../index.js"
import { fixtures } from "./fixtures.js"

describe("computer api contract fixtures", () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} -> ${fixture.valid ? "valid" : "invalid"}`, () => {
      const result = fixture.schema.safeParse(fixture.value)
      expect(result.success).toBe(fixture.valid)
    })
  }
})

describe("schema behaviours", () => {
  it("exposes the contract version", () => {
    expect(COMPUTER_API_VERSION).toBe("v1")
  })

  it("buckets an unknown state under unknown and keeps known ones", async () => {
    expect(await computerStateSchema.parseAsync("running")).toBe("running")
    expect(await computerStateSchema.parseAsync("something-new")).toBe("unknown")
  })

  it("declares the full set of known states", () => {
    expect([...COMPUTER_STATES]).toContain("suspended")
    expect([...COMPUTER_STATES]).toHaveLength(8)
  })

  it("preserves extra fields on a status response", async () => {
    const parsed = await computerStatusSchema.parseAsync({
      name: "cmp-001",
      state: "running",
      egress: [],
      pinsStale: false,
    })
    expect(parsed.pinsStale).toBe(false)
  })

  it("ports are integer pairs", async () => {
    expect((await portPublishSchema.parseAsync({ host: 1, guest: 2 })).guest).toBe(2)
    await expect(portPublishSchema.parseAsync({ host: "1", guest: 2 })).rejects.toThrow()
  })

  it("create response keeps optional ports absent when the controller omits them", async () => {
    const parsed = await createComputerResponseSchema.parseAsync({
      id: "cmp-001",
      template: "workstation",
      state: "starting",
    })
    expect(parsed.ports).toBeUndefined()
    expect(parsed.state).toBe("starting")
  })
})

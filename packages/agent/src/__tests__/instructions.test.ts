import { describe, it, expect } from "vitest"
import { defineAgent } from "../define-agent.js"
import {
  composeInstructions,
  DEFAULT_BOUNDARIES_HEADER,
} from "../instructions.js"

const handle = defineAgent({
  schema: "agent/v1",
  id: "synthetic",
  description: "A synthetic agent.",
  model: "provider/model",
  persona: { inline: { name: "Sam", tone: "dry" } },
  boundaries: ["never A", "never B"],
  traits: { rigor: 8 },
})

describe("composeInstructions", () => {
  it("default header carries no em dash", () => {
    const out = composeInstructions(handle, "BODY")
    expect(out).not.toContain("\u2014")
    expect(out).toContain(`${DEFAULT_BOUNDARIES_HEADER}\n- never A\n- never B`)
  })

  it("honours a custom boundaries header", () => {
    const out = composeInstructions(handle, "BODY", { boundariesHeader: "Limits:" })
    expect(out).toContain("Limits:\n- never A\n- never B")
    expect(out).not.toContain(DEFAULT_BOUNDARIES_HEADER)
  })

  it("honours a custom section order", () => {
    const out = composeInstructions(handle, "BODY", {
      boundariesHeader: "Limits:",
      sectionOrder: ["boundaries", "body", "traits", "persona"],
    })
    const at = (needle: string) => out.indexOf(needle)
    expect(at("Limits:")).toBeGreaterThanOrEqual(0)
    expect(at("Limits:")).toBeLessThan(at("BODY"))
    expect(at("BODY")).toBeLessThan(at("Trait scores"))
    expect(at("Trait scores")).toBeLessThan(at("Persona"))
  })

  it("renders only the sections listed", () => {
    const out = composeInstructions(handle, "BODY", { sectionOrder: ["body"] })
    expect(out).toBe("BODY")
  })

  it("keeps the default order when no options are given", () => {
    const out = composeInstructions(handle, "BODY")
    const at = (needle: string) => out.indexOf(needle)
    expect(at("BODY")).toBeLessThan(at("Persona"))
    expect(at("Persona")).toBeLessThan(at(DEFAULT_BOUNDARIES_HEADER))
    expect(at(DEFAULT_BOUNDARIES_HEADER)).toBeLessThan(at("Trait scores"))
  })
})

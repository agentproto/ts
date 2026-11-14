import { describe, expect, it } from "vitest"

import {
  capabilityGrantDecider,
  combineGrantDecisions,
  shadowDeliveryGrant,
  subjectMatchesCapability,
  type DeliveryGrantProducer,
} from "../grant.js"

const github: DeliveryGrantProducer = { capabilities: { subjects: ["github"] } }

describe("subjectMatchesCapability", () => {
  it("matches a subject scheme against a declared scheme", () => {
    expect(subjectMatchesCapability("github:acme/widgets#42", "github")).toBe(true)
    expect(subjectMatchesCapability("slack:incidents", "github")).toBe(false)
  })

  it("matches anything for the wildcard capability", () => {
    expect(subjectMatchesCapability("slack:incidents", "*")).toBe(true)
    expect(subjectMatchesCapability("anything", "*")).toBe(true)
  })

  it("also accepts a full prefix capability", () => {
    expect(subjectMatchesCapability("github:acme/widgets#42", "github:acme")).toBe(true)
    expect(subjectMatchesCapability("github:other/widgets#42", "github:acme")).toBe(false)
  })
})

describe("capabilityGrantDecider", () => {
  it("denies publishing a subject the declared capabilities do not cover", () => {
    expect(capabilityGrantDecider(github, "delivery:publish", "slack:incidents")).toBe("deny")
  })

  it("allows publishing a subject the declared capabilities cover", () => {
    expect(capabilityGrantDecider(github, "delivery:publish", "github:acme/widgets#42")).toBe("allow")
  })

  it("allows waking when capabilities are declared", () => {
    expect(capabilityGrantDecider(github, "delivery:wake", "sess_1")).toBe("allow")
  })

  it("is unknown when the producer declares no capabilities", () => {
    expect(capabilityGrantDecider({}, "delivery:publish", "slack:incidents")).toBe("unknown")
    expect(capabilityGrantDecider({}, "delivery:wake", "sess_1")).toBe("unknown")
    expect(capabilityGrantDecider({ capabilities: { subjects: [] } }, "delivery:publish", "x:y")).toBe("unknown")
  })
})

describe("combineGrantDecisions", () => {
  it("lets a deny dominate every other verdict", () => {
    expect(combineGrantDecisions(["allow", "deny"])).toBe("deny")
    expect(combineGrantDecisions(["error", "deny"])).toBe("deny")
  })

  it("reports an error when nothing denied", () => {
    expect(combineGrantDecisions(["allow", "error"])).toBe("error")
  })

  it("allows only when every decision allowed", () => {
    expect(combineGrantDecisions(["allow", "allow"])).toBe("allow")
  })

  it("is unknown otherwise", () => {
    expect(combineGrantDecisions(["allow", "unknown"])).toBe("unknown")
    expect(combineGrantDecisions(["unknown", "unknown"])).toBe("unknown")
  })
})

describe("shadowDeliveryGrant", () => {
  it("records allow for a covered publish and the wake that follows it", () => {
    expect(
      shadowDeliveryGrant({ producer: github, subject: "github:acme/widgets#42", target: "sess_1" }),
    ).toBe("allow")
  })

  it("records deny for an uncovered publish", () => {
    expect(
      shadowDeliveryGrant({ producer: github, subject: "slack:incidents", target: "sess_1" }),
    ).toBe("deny")
  })

  it("records unknown for a producer with no capabilities", () => {
    expect(shadowDeliveryGrant({ producer: {}, subject: "slack:incidents", target: "sess_1" })).toBe("unknown")
  })

  it("records error instead of throwing when the decision throws", () => {
    const hostile = {
      get capabilities() {
        throw new Error("no capabilities for you")
      },
    } as DeliveryGrantProducer
    expect(shadowDeliveryGrant({ producer: hostile, subject: "slack:incidents", target: "sess_1" })).toBe("error")
  })

  it("never lets a throwing decider escape", () => {
    expect(
      shadowDeliveryGrant({
        producer: github,
        subject: "github:acme/widgets#42",
        target: "sess_1",
        decide: () => {
          throw new Error("boom")
        },
      }),
    ).toBe("error")
  })
})

import { readFileSync } from "node:fs"

import { describe, it, expect } from "vitest"

import {
  HOOKS_CONTRACT,
  HOOKS_ERROR_CODES,
  HOOK_CAPABILITY_SURFACES,
  HOOK_PATHS,
  HooksContractError,
  parseAgentHookMap,
  parseHookActionRef,
  parseHookEventRef,
  parseHostEventRegistration,
  type HostEventRegistration,
  type HookReaction,
  type HooksErrorCode,
} from "../hooks.js"

const fixtureDir = new URL("../../fixtures/action-hooks-v1/", import.meta.url)

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8"))
}

interface ExpectedReaction {
  event: string
  eventKind: string
  portable: boolean
  host?: string
  thresholdSeconds?: number
  action: string
  inputs: Record<string, unknown> | null
  delivery: string
  reconciliation: string
}

interface ValidAgentHookCase {
  name: string
  on: unknown
  registrations?: HostEventRegistration[]
  expect: ExpectedReaction[]
}

interface InvalidAgentHookCase {
  name: string
  on: unknown
  registrations?: HostEventRegistration[]
}

interface InvalidRegistrationCase {
  name: string
  registration: unknown
}

interface ConformanceFixture {
  contract: string
  hostEvents: HostEventRegistration[]
  agentHookMaps: {
    valid: ValidAgentHookCase[]
    invalid: InvalidAgentHookCase[]
  }
  hostEventRegistrations: {
    valid: HostEventRegistration[]
    invalid: InvalidRegistrationCase[]
  }
}

const fixture = readFixture("conformance.json") as ConformanceFixture

function project(reaction: HookReaction): ExpectedReaction {
  return {
    event: reaction.event.event,
    eventKind: reaction.event.kind,
    portable: reaction.event.portable,
    ...(reaction.event.host ? { host: reaction.event.host } : {}),
    ...(reaction.event.thresholdSeconds !== undefined
      ? { thresholdSeconds: reaction.event.thresholdSeconds }
      : {}),
    action: reaction.action.action,
    inputs: reaction.action.inputs ?? null,
    delivery: reaction.delivery,
    reconciliation: reaction.reconciliation,
  }
}

describe("action-hooks/v1 contract fixtures", () => {
  it("freezes the contract and path vocabulary", () => {
    expect(HOOKS_CONTRACT).toBe("action-hooks/v1")
    expect(fixture.contract).toBe(HOOKS_CONTRACT)
    expect(HOOK_PATHS).toEqual(["admission", "lifecycle", "reaction"])
    expect(HOOK_CAPABILITY_SURFACES).toEqual([
      "harness_capabilities",
      "session_capabilities",
    ])
  })

  it("parses every valid AIP-42 on: conformance case", () => {
    for (const testCase of fixture.agentHookMaps.valid) {
      const registrations = testCase.registrations ?? fixture.hostEvents
      const actual = parseAgentHookMap(testCase.on, { hostEvents: registrations }).map(project)
      expect(actual, testCase.name).toEqual(testCase.expect)
    }
  })

  it("rejects every invalid AIP-42 on: conformance case", () => {
    for (const testCase of fixture.agentHookMaps.invalid) {
      const registrations = testCase.registrations ?? fixture.hostEvents
      expect(
        () => parseAgentHookMap(testCase.on, { hostEvents: registrations }),
        testCase.name,
      ).toThrow(/action-hooks\/v1|event ref|action ref|`on:`|agent/i)
    }
  })

  it("parses valid host event registrations", () => {
    for (const registration of fixture.hostEventRegistrations.valid) {
      expect(parseHostEventRegistration(registration)).toEqual({
        event: "agentproto:child-housekeeping",
        host: "agentproto",
        portability: "nonportable",
      })
    }
  })

  it("rejects invalid host event registrations", () => {
    for (const testCase of fixture.hostEventRegistrations.invalid) {
      expect(
        () => parseHostEventRegistration(testCase.registration),
        testCase.name,
      ).toThrow(/host event/i)
    }
  })

  it("accepts the AIP-42 actionRef ref spelling", () => {
    expect(parseHookActionRef({ ref: "session:child-housekeeping" })).toEqual({
      action: "session:child-housekeeping",
    })
  })

})

describe("AIP-37 harness extension events", () => {
  const harnessEvents = [
    "turn-interrupt",
    "prompt-submit",
    "permission-request",
    "compact-start",
    "compact-end",
    "subagent-start",
    "subagent-end",
  ]

  it.each(harnessEvents)("parses %s as a standard event", event => {
    expect(parseHookEventRef(event)).toEqual({
      raw: event,
      event,
      kind: "standard",
      portable: true,
    })
  })
})

describe("HooksContractError codes", () => {
  function expectCode(fn: () => unknown, code: HooksErrorCode): void {
    try {
      fn()
    } catch (error) {
      expect(error).toBeInstanceOf(HooksContractError)
      expect((error as HooksContractError).code).toBe(code)
      return
    }
    throw new Error(`expected HooksContractError with code ${code}`)
  }

  it("declares unique kebab-case codes", () => {
    expect(new Set(HOOKS_ERROR_CODES).size).toBe(HOOKS_ERROR_CODES.length)
    for (const code of HOOKS_ERROR_CODES) {
      expect(code).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
  })

  it("uses action-ref-invalid for a malformed action id", () => {
    expectCode(() => parseHookActionRef("Bad"), "action-ref-invalid")
  })

  it("uses action-ref-type for a non-string, non-object ref", () => {
    expectCode(() => parseHookActionRef(42), "action-ref-type")
  })

  it("uses action-ref-ambiguous when action and ref are both set", () => {
    expectCode(
      () => parseHookActionRef({ action: "session:a", ref: "session:b" }),
      "action-ref-ambiguous",
    )
  })

  it("uses action-ref-missing when neither action nor ref is set", () => {
    expectCode(() => parseHookActionRef({}), "action-ref-missing")
  })

  it("uses action-ref-inputs-invalid for non-object inputs", () => {
    expectCode(
      () => parseHookActionRef({ action: "session:a", inputs: [] }),
      "action-ref-inputs-invalid",
    )
  })

  it("uses event-ref-invalid for an empty or whitespace event", () => {
    expectCode(() => parseHookEventRef(""), "event-ref-invalid")
    expectCode(() => parseHookEventRef("turn end"), "event-ref-invalid")
  })

  it("uses event-ref-host-unregistered for an unregistered namespaced event", () => {
    expectCode(
      () => parseHookEventRef("agentproto:child-housekeeping"),
      "event-ref-host-unregistered",
    )
  })

  it("uses host-event-registration-invalid for a malformed registration", () => {
    expectCode(
      () => parseHostEventRegistration({ event: "turn-end" }),
      "host-event-registration-invalid",
    )
  })

  it("uses host-event-registration-mismatch when host does not match the namespace", () => {
    expectCode(
      () => parseHostEventRegistration({ event: "agentproto:x", host: "other" }),
      "host-event-registration-mismatch",
    )
  })

  it("uses agent-hook-map-invalid for a non-object on map", () => {
    expectCode(() => parseAgentHookMap([]), "agent-hook-map-invalid")
  })

  it("uses agent-hook-entry-empty for an empty action list", () => {
    expectCode(
      () => parseAgentHookMap({ "turn-end": [] }),
      "agent-hook-entry-empty",
    )
  })
})

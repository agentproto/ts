import { readFileSync } from "node:fs"

import { describe, it, expect } from "vitest"

import {
  HOOKS_CONTRACT,
  HOOK_CAPABILITY_SURFACES,
  HOOK_PATHS,
  parseAgentHookMap,
  parseHookActionRef,
  parseHookEventRef,
  parseHostEventRegistration,
  type HostEventRegistration,
  type HookReaction,
} from "../hooks.js"

const fixtureDir = new URL("../../fixtures/hooks-v1/", import.meta.url)

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

describe("hooks/v1 contract fixtures", () => {
  it("freezes the contract and path vocabulary", () => {
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
      ).toThrow(/hooks\/v1|event ref|action ref|`on:`|agent/i)
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

  it("keeps the illustrative AIP-41 event routine strict and action-targeted", () => {
    const routine = readFixture("aip-41-event-routine.json") as Record<string, unknown>
    expect(routine.schema).toBe("routine/v1")
    expect(typeof routine.description).toBe("string")
    expect((routine.schedule as { kind?: unknown }).kind).toBe("event")
    expect((routine.schedule as { on?: unknown }).on).toBe("turn-end")
    expect((routine.target as { action?: unknown }).action).toBe(
      "session:child-housekeeping",
    )
    expect(parseHookEventRef("turn-end").kind).toBe("standard")
  })
})

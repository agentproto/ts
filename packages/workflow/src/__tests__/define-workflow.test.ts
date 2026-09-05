import { describe, it, expect } from "vitest"
import { defineWorkflow } from "../define-workflow.js"
import type { StepAgent } from "../types.js"

describe("defineWorkflow (AIP-15)", () => {
  // The AIP-15 doctype uses 'id' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineWorkflow).toBe("function")
  })

  // TODO: spec-15 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})

describe("defineWorkflow — kind: gate cross-field rule (AIP-15 P3)", () => {
  it("accepts a gate step with a non-empty command", () => {
    expect(() =>
      defineWorkflow({
        name: "Gate",
        id: "gate-ok",
        description: "A gate step with a command.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [{ id: "g", kind: "gate", command: "pnpm test" }],
      }),
    ).not.toThrow()
  })

  it("rejects a gate step with an empty command", () => {
    expect(() =>
      defineWorkflow({
        name: "Gate",
        id: "gate-bad",
        description: "A gate step with no command.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [{ id: "g", kind: "gate", command: "" }],
      }),
    ).toThrow(/gate step 'g' needs a non-empty 'command'/)
  })

  it("rejects a gate step nested inside a map body", () => {
    expect(() =>
      defineWorkflow({
        name: "Gate",
        id: "gate-nested-bad",
        description: "A gate step missing a command, nested in a map.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [
          {
            id: "m",
            kind: "map",
            over: "$input.items",
            steps: [{ id: "g", kind: "gate", command: "" }],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        ],
      }),
    ).toThrow(/gate step 'g' needs a non-empty 'command'/)
  })
})

describe("defineWorkflow — StepAgent.harness pinning (AIP-15 P2)", () => {
  it("passes a harness block through build() unchanged", () => {
    const harness: StepAgent["harness"] = {
      model: "opus",
      effort: "high",
      role: "executor",
      tools: ["read"],
      skills: ["review"],
      cwd: "/tmp/work",
    }
    const wf = defineWorkflow({
      name: "Harness",
      id: "harness-ok",
      description: "An agent step with harness pinning.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        { id: "s1", kind: "agent", adapter: "claude-code", prompt: "hi", harness },
      ],
    })
    const step = wf.steps[0] as unknown as StepAgent
    expect(step.harness).toEqual(harness)
  })
})

describe("defineWorkflow — StepAgent.harness.knowledge (AIP-15 P2)", () => {
  const base = {
    name: "Knowledge",
    version: "0.1.0",
    inputs: {},
    outputs: {},
  }

  it("accepts an agent step with well-formed knowledge selectors", () => {
    expect(() =>
      defineWorkflow({
        ...base,
        id: "knowledge-ok",
        description: "An agent step with knowledge selectors.",
        steps: [
          {
            id: "s1",
            kind: "agent",
            adapter: "claude-code",
            prompt: "hi",
            harness: {
              knowledge: [
                {
                  workspace: "../corpus-writer",
                  anyOf: ["book-factory", "drafting"],
                  allOf: ["style-guide"],
                  kinds: ["fact"],
                  maxEntries: 20,
                  mode: "files",
                },
                { workspace: "/abs/corpus" },
              ],
            },
          },
        ],
      }),
    ).not.toThrow()
  })

  it("rejects a knowledge selector with an unsupported mode", () => {
    expect(() =>
      defineWorkflow({
        ...base,
        id: "knowledge-bad-mode",
        description: "An agent step with a bad knowledge mode.",
        steps: [
          {
            id: "s1",
            kind: "agent",
            adapter: "claude-code",
            prompt: "hi",
            harness: { knowledge: [{ workspace: "../corpus", mode: "tool" }] },
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).toThrow(/invalid harness block.*mode/)
  })

  it("rejects a knowledge selector with no workspace", () => {
    expect(() =>
      defineWorkflow({
        ...base,
        id: "knowledge-no-ws",
        description: "An agent step with a workspace-less selector.",
        steps: [
          {
            id: "s1",
            kind: "agent",
            adapter: "claude-code",
            prompt: "hi",
            harness: { knowledge: [{ anyOf: ["x"] }] },
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).toThrow(/invalid harness block.*workspace/)
  })

  it("rejects a knowledge selector with unknown fields", () => {
    expect(() =>
      defineWorkflow({
        ...base,
        id: "knowledge-unknown",
        description: "An agent step with an unknown selector field.",
        steps: [
          {
            id: "s1",
            kind: "agent",
            adapter: "claude-code",
            prompt: "hi",
            harness: { knowledge: [{ workspace: "../corpus", tags: ["x"] }] },
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).toThrow(/invalid harness block/)
  })
})

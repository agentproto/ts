import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  ControllerManifestError,
  parseControllerManifest,
  type ControllerManifestIssue,
} from "../manifest.js"

const RESEARCH_ASSISTANT = readFileSync(
  new URL("./fixtures/research-assistant.md", import.meta.url),
  "utf8",
)

function issuesOf(input: unknown): ControllerManifestIssue[] {
  try {
    parseControllerManifest(input)
  } catch (err) {
    expect(err).toBeInstanceOf(ControllerManifestError)
    return (err as ControllerManifestError).issues
  }
  throw new Error("expected the manifest to be rejected")
}

const minimal = (modes: unknown) => ({ id: "x", name: "X", version: "0.1.0", modes })

describe("parseControllerManifest: research-assistant.md (frontmatter markdown)", () => {
  const manifest = parseControllerManifest(RESEARCH_ASSISTANT)

  it("reads the top-level identity", () => {
    expect(manifest.id).toBe("research-assistant")
    expect(manifest.name).toBe("Research Assistant")
    expect(manifest.version).toBe("0.1.0")
    expect(manifest.spec).toBe("harness/v1")
  })

  it("keeps modes plan/execute in order, with default and transitionsTo", () => {
    expect(manifest.modes.map(m => m.id)).toEqual(["plan", "execute"])
    const [plan, execute] = manifest.modes
    expect(plan!.default).toBe(true)
    expect(plan!.transitionsTo).toBe("execute")
    expect(plan!.defaultModelId).toBe("claude-sonnet-4-6")
    expect(execute!.default).toBe(false)
    expect(execute!.transitionsTo).toBeUndefined()
  })

  it("passes host profile fields it does not model through untouched", () => {
    expect(manifest.modes[0]).toMatchObject({
      color: "#3b82f6",
      builtins: { submit_plan: "required", task_check: false },
    })
  })
})

describe("parseControllerManifest: $resolver references", () => {
  it("survive parsing untouched (markdown form)", () => {
    const manifest = parseControllerManifest(RESEARCH_ASSISTANT)
    expect(manifest.storage).toEqual({
      $resolver: "@guilde/harness/storage/postgres",
      input: { connectionStringEnv: "DATABASE_URL", storeId: "guilde-harness" },
    })
    expect(manifest.memory).toEqual({ $resolver: "@guilde/harness/memory/shared" })
    expect(manifest.models?.resolver).toEqual({ $resolver: "@guilde/harness/model/resolver" })
    expect(manifest.modes[1]!.model).toEqual({
      $resolver: "@guilde/harness/model/for-mode",
      input: {
        default: "claude-sonnet-4-6",
        allowed: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
      },
    })
  })

  it("survive parsing untouched (object form), extra keys included", () => {
    const agent = { $resolver: "@host/agent/inline", input: { ref: "AGENT.md" }, cache: true }
    const manifest = parseControllerManifest({
      ...minimal([{ id: "build", agent, tools: { $resolver: "@host/tools/fs" } }]),
      workspace: { $resolver: "@host/workspace/cwd" },
    })
    expect(manifest.modes[0]!.agent).toEqual(agent)
    expect(manifest.modes[0]!.tools).toEqual({ $resolver: "@host/tools/fs" })
    expect(manifest.workspace).toEqual({ $resolver: "@host/workspace/cwd" })
  })

  it("rejects a host reference without $resolver, naming the path", () => {
    expect(issuesOf({ ...minimal([{ id: "a" }]), storage: { input: {} } })).toEqual([
      expect.objectContaining({ path: "storage.$resolver" }),
    ])
  })
})

describe("parseControllerManifest: portable fields (object form)", () => {
  it("accepts the full portable surface", () => {
    const manifest = parseControllerManifest({
      spec: "mastra.agent-controller/v1",
      ...minimal([
        {
          id: "plan",
          default: true,
          transitionsTo: "build",
          instructions: "Plan only.",
          availableTools: ["view", "find_files"],
        },
        { id: "build", availableTools: [] },
      ]),
      subagents: [{ id: "explore", name: "Explore", description: "Read the repo", maxSteps: 20 }],
      omConfig: { defaultObservationThreshold: 30000 },
      models: { allowed: ["anthropic/claude-sonnet-5"] },
      permissions: { categories: { execute: "ask" }, tools: { write_file: "deny" } },
    })
    expect(manifest.modes[0]!.availableTools).toEqual(["view", "find_files"])
    expect(manifest.modes[1]!.availableTools).toEqual([])
    expect(manifest.subagents?.[0]!.maxSteps).toBe(20)
    expect(manifest.permissions?.categories?.execute).toBe("ask")
  })
})

describe("parseControllerManifest: invalid manifests name the field path", () => {
  it("missing modes", () => {
    const { modes: _modes, ...noModes } = minimal([])
    expect(issuesOf(noModes)).toEqual([expect.objectContaining({ path: "modes" })])
  })

  it("empty modes", () => {
    expect(issuesOf(minimal([]))).toEqual([expect.objectContaining({ path: "modes" })])
  })

  it("two default modes", () => {
    const issues = issuesOf(
      minimal([
        { id: "plan", default: true },
        { id: "build", default: true },
      ]),
    )
    expect(issues).toEqual([
      {
        path: "modes.1.default",
        message: "only one mode may be the default (mode 'plan' already is)",
      },
    ])
  })

  it("transitionsTo naming an unknown mode", () => {
    const issues = issuesOf(minimal([{ id: "plan", transitionsTo: "exec" }, { id: "execute" }]))
    expect(issues).toEqual([
      { path: "modes.0.transitionsTo", message: "transitionsTo names unknown mode 'exec'" },
    ])
  })

  it("duplicate mode ids", () => {
    expect(issuesOf(minimal([{ id: "a" }, { id: "a" }]))).toEqual([
      expect.objectContaining({ path: "modes.1.id" }),
    ])
  })

  it("the error message lists every path", () => {
    expect(() => parseControllerManifest({ modes: [{}] })).toThrowError(
      /- id: [\s\S]*- modes\.0\.id: /,
    )
  })

  it("markdown without frontmatter", () => {
    expect(issuesOf("# just a heading\n")).toEqual([
      expect.objectContaining({ path: "(root)" }),
    ])
  })

  it("an unknown spec id", () => {
    expect(issuesOf({ spec: "agent/v1", ...minimal([{ id: "a" }]) })).toEqual([
      expect.objectContaining({ path: "spec" }),
    ])
  })
})

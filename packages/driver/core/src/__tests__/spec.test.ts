import { describe, it, expect } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { driverSpec, driverVerbs } from "../spec.js"

// ── helpers ───────────────────────────────────────────────────────────────

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "agentproto-driver-spec-"))
}

// ── driverSpec shape ─────────────────────────────────────────────────────

describe("driverSpec — identity fields", () => {
  it("has the expected name / aip / schemaLiteral", () => {
    expect(driverSpec.name).toBe("driver")
    expect(driverSpec.aip).toBe(30)
    expect(driverSpec.schemaLiteral).toBe("agentproto/driver/v1")
  })

  it("pathOf derives <id>/DRIVER.md", () => {
    // driverSpec.pathOf receives a DriverHandle; fabricate one via define.
    const handle = driverSpec.define({
      id: "gh-cli",
      name: "GitHub CLI",
      description: "Drives gh CLI.",
      kind: "cli",
      implements: [{ tool: "list-prs", version: "^1.0.0" }],
    })
    expect(driverSpec.pathOf(handle)).toBe("gh-cli/DRIVER.md")
  })
})

// ── driverSpec.define — stub inject (D3) ─────────────────────────────────

describe("driverSpec.define — stub execute injection (D3)", () => {
  it("succeeds without execute bodies and injects stubs", () => {
    const handle = driverSpec.define({
      id: "my-driver",
      name: "My Driver",
      description: "A driver without bodies.",
      kind: "http",
      implements: [{ tool: "my-tool", version: "^1.0.0" }],
    })
    expect(handle.id).toBe("my-driver")
    expect(typeof handle.execute["my-tool"]).toBe("function")
    expect(() => handle.execute["my-tool"]?.({ input: {}, context: {} as never, driverCtx: {} as never, signal: new AbortController().signal })).toThrow(
      /stub: no execute body for 'my-tool'/,
    )
  })

  it("bypasses stub injection when execute is provided", () => {
    const real = async () => ({ ok: true })
    const handle = driverSpec.define({
      id: "my-driver-2",
      name: "My Driver 2",
      description: "A driver with real bodies.",
      kind: "sdk",
      implements: [{ tool: "my-tool", version: "^1.0.0" }],
      execute: { "my-tool": real },
    })
    expect(handle.execute["my-tool"]).toBe(real)
  })

  it("normalizes path-style tool refs when injecting stubs (D4)", () => {
    const handle = driverSpec.define({
      id: "path-driver",
      name: "Path Driver",
      description: "Tool ref as a path.",
      kind: "cli",
      implements: [{ tool: "./tools/image-create/TOOL.md", version: "^1.0.0" }],
    })
    // normalizeToolId strips the path decoration → "image-create"
    expect(typeof handle.execute["image-create"]).toBe("function")
  })
})

// ── round-trip: create → load → list → delete ────────────────────────────

describe("driverVerbs — create → load → list → delete round-trip", () => {
  it("writes a DRIVER.md and reloads the same handle", async () => {
    const workspace = tmpWorkspace()
    try {
      const created = await driverVerbs.create(
        {
          id: "openai-images-http",
          name: "OpenAI Images (HTTP)",
          description:
            "Image generation via the OpenAI HTTP API. Implements image.create.",
          version: "1.0.0",
          kind: "http",
          implements: [
            {
              tool: "./tools/image-create/TOOL.md",
              version: "^1.0.0",
              schemaNarrowing: { dropInputs: ["seed", "negative_prompt"] },
            },
          ],
          policyTags: ["third-party-llm", "us-data-residency"],
          network: { egress: ["api.openai.com"] },
          region: ["global"],
          tags: ["openai"],
        },
        { dir: workspace },
      )

      // Path convention: <id>/DRIVER.md
      expect(created.path).toBe(
        join(workspace, "openai-images-http", "DRIVER.md"),
      )

      // The on-disk file must be valid YAML with snake_case keys.
      const raw = readFileSync(created.path, "utf8")
      expect(raw).toContain("schema: agentproto/driver/v1")
      expect(raw).toContain("policy_tags:")
      expect(raw).not.toContain("policyTags:")
      expect(raw).toContain("schema_narrowing:")
      expect(raw).not.toContain("schemaNarrowing:")
      expect(raw).toContain("drop_inputs:")
      expect(raw).not.toContain("dropInputs:")

      // load() must round-trip back to camelCase DriverHandle.
      const loaded = await driverVerbs.load(created.path)
      expect(loaded.handle.id).toBe("openai-images-http")
      expect(loaded.handle.kind).toBe("http")
      expect(loaded.handle.policyTags).toEqual([
        "third-party-llm",
        "us-data-residency",
      ])
      expect(loaded.handle.implements[0]?.schemaNarrowing?.dropInputs).toEqual(
        ["seed", "negative_prompt"],
      )
      expect(loaded.handle.network.egress).toEqual(["api.openai.com"])
      expect(loaded.handle.tags).toEqual(["openai"])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("list() discovers DRIVER.md files under a workspace", async () => {
    const workspace = tmpWorkspace()
    try {
      await driverVerbs.create(
        {
          id: "driver-a",
          name: "Driver A",
          description: "First driver.",
          kind: "cli",
          implements: [{ tool: "tool-a", version: "^1.0.0" }],
        },
        { dir: workspace },
      )
      await driverVerbs.create(
        {
          id: "driver-b",
          name: "Driver B",
          description: "Second driver.",
          kind: "http",
          implements: [{ tool: "tool-b", version: "^1.0.0" }],
        },
        { dir: workspace },
      )

      const handles = await driverVerbs.list(workspace)
      const ids = handles.map((h) => h.id).sort()
      expect(ids).toEqual(["driver-a", "driver-b"])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("delete() removes the DRIVER.md from disk", async () => {
    const workspace = tmpWorkspace()
    try {
      const { path } = await driverVerbs.create(
        {
          id: "ephemeral",
          name: "Ephemeral",
          description: "Will be deleted.",
          kind: "mcp",
          implements: [{ tool: "tool-x", version: "^1.0.0" }],
        },
        { dir: workspace },
      )
      await driverVerbs.delete(path)
      const handles = await driverVerbs.list(workspace)
      expect(handles).toHaveLength(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

// ── snake↔camel round-trip coverage ──────────────────────────────────────

describe("driverSpec — snake↔camel round-trip fidelity", () => {
  it("policy_tags survives create → raw YAML → load intact", async () => {
    const workspace = tmpWorkspace()
    try {
      await driverVerbs.create(
        {
          id: "policy-driver",
          name: "Policy Driver",
          description: "Verify policy_tags mapping.",
          kind: "sdk",
          implements: [{ tool: "t", version: "^1.0.0" }],
          policyTags: ["pii-safe", "self-hosted"],
        },
        { dir: workspace },
      )
      const raw = readFileSync(
        join(workspace, "policy-driver", "DRIVER.md"),
        "utf8",
      )
      expect(raw).toContain("policy_tags:")
      expect(raw).toContain("- pii-safe")
      expect(raw).toContain("- self-hosted")

      const { handle } = await driverVerbs.load(
        join(workspace, "policy-driver", "DRIVER.md"),
      )
      expect(handle.policyTags).toEqual(["pii-safe", "self-hosted"])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("implements[].schema_narrowing.drop_inputs survives round-trip", async () => {
    const workspace = tmpWorkspace()
    try {
      await driverVerbs.create(
        {
          id: "narrowing-driver",
          name: "Narrowing Driver",
          description: "Verify schema_narrowing mapping.",
          kind: "http",
          implements: [
            {
              tool: "image.create",
              version: "^1.0.0",
              schemaNarrowing: {
                dropInputs: ["seed", "cfg_scale"],
                dropOutputs: ["nsfw_score"],
              },
            },
          ],
        },
        { dir: workspace },
      )

      const raw = readFileSync(
        join(workspace, "narrowing-driver", "DRIVER.md"),
        "utf8",
      )
      expect(raw).toContain("schema_narrowing:")
      expect(raw).toContain("drop_inputs:")
      expect(raw).toContain("- seed")
      expect(raw).toContain("drop_outputs:")
      expect(raw).toContain("- nsfw_score")

      const { handle } = await driverVerbs.load(
        join(workspace, "narrowing-driver", "DRIVER.md"),
      )
      expect(handle.implements[0]?.schemaNarrowing?.dropInputs).toEqual([
        "seed",
        "cfg_scale",
      ])
      expect(handle.implements[0]?.schemaNarrowing?.dropOutputs).toEqual([
        "nsfw_score",
      ])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("dryRun: create returns rendered without writing to disk", async () => {
    const workspace = tmpWorkspace()
    try {
      const { rendered } = await driverVerbs.create(
        {
          id: "dry-driver",
          name: "Dry Driver",
          description: "Dry run only.",
          kind: "builtin",
          implements: [{ tool: "noop", version: "^1.0.0" }],
        },
        { dir: workspace, dryRun: true },
      )
      expect(rendered).toContain("schema: agentproto/driver/v1")
      // Nothing written to disk.
      const handles = await driverVerbs.list(workspace)
      expect(handles).toHaveLength(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

import { describe, it, expect } from "vitest"
import { z } from "zod"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTool } from "../create-tool.js"
import { parseToolManifest } from "../manifest/index.js"

describe("createTool", () => {
  it("renders a TOOL.md that round-trips through parseToolManifest", async () => {
    const result = await createTool(
      {
        id: "echo",
        name: "Echo",
        description: "Returns its input verbatim.",
        version: "1.0.0",
        inputSchema: z.object({ msg: z.string() }),
        outputSchema: z.object({ msg: z.string() }),
        mutates: ["fs:read"],
        approval: "on-mutate",
        riskLevel: 1,
        costClass: "trivial",
        timeoutMs: 5000,
        idempotent: true,
        tags: ["example", "fs"],
        metadata: { "vendor.namespace": "anything" },
      },
      { dir: "/tmp/unused", dryRun: true },
    )

    expect(result.path).toBe("/tmp/unused/echo/TOOL.md")
    expect(result.rendered).toContain("schema: agentproto/tool/v1")
    expect(result.rendered).toContain("id: echo")
    expect(result.rendered).toContain("# Echo")

    // The .md round-trips through the parser — the serializer
    // produces a frontmatter shape the parser accepts.
    const parsed = parseToolManifest(result.rendered)
    expect(parsed.frontmatter.id).toBe("echo")
    expect(parsed.frontmatter.name).toBe("Echo")
    expect(parsed.frontmatter.tags).toEqual(["example", "fs"])
    expect(parsed.frontmatter.risk_level).toBe(1)
    expect(parsed.frontmatter.cost_class).toBe("trivial")
    expect(parsed.frontmatter.timeout_ms).toBe(5000)
    expect(parsed.body).toContain("# Echo")
  })

  it("filters non-serialisable fields (zod schemas, functions)", async () => {
    const result = await createTool(
      {
        id: "echo",
        description: "x".repeat(10),
        inputSchema: z.object({}),
        outputSchema: z.object({}),
      },
      { dir: "/tmp/x", dryRun: true },
    )
    expect(result.rendered).not.toContain("inputSchema")
    expect(result.rendered).not.toContain("outputSchema")
  })

  it("writes to disk when dryRun is false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-tool-"))
    try {
      const r = await createTool(
        {
          id: "echo",
          description: "x".repeat(10),
          inputSchema: z.object({}),
          outputSchema: z.object({}),
        },
        { dir },
      )
      const onDisk = readFileSync(r.path, "utf8")
      expect(onDisk).toBe(r.rendered)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

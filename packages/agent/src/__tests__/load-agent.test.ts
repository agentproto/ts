import { describe, it, expect } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadAgent } from "../load-agent.js"
import { EXTENDS_MAX_DEPTH } from "../validate-extends-chain.js"

/** Write a minimal valid AGENT.md to `dir/<id>/AGENT.md`. */
async function writeAgentMd(
  workspace: string,
  id: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const dir = join(workspace, ".agents", id)
  await mkdir(dir, { recursive: true })
  const extendsLine = extra.extends ? `extends: ${extra.extends}` : ""
  const source = [
    "---",
    "schema: agent/v1",
    `id: ${id}`,
    `description: Agent ${id} for testing`,
    "model: test-model",
    extendsLine,
    "---",
    "",
    `You are agent ${id}.`,
  ]
    .filter((l) => l !== "")
    .join("\n") + "\n"
  const path = join(dir, "AGENT.md")
  await writeFile(path, source, "utf8")
  return path
}

describe("loadAgent (AIP-42 extends-chain validation)", () => {
  it("loads a simple agent with no extends", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-load-agent-"))
    try {
      const path = await writeAgentMd(workspace, "simple")
      const { handle } = await loadAgent(path, { workspace })
      expect(handle.id).toBe("simple")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("loads an agent with a valid single-level extends", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-load-agent-"))
    try {
      await writeAgentMd(workspace, "parent")
      const childPath = await writeAgentMd(workspace, "child", {
        extends: "parent",
      })
      const { handle } = await loadAgent(childPath, { workspace })
      expect(handle.id).toBe("child")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it(`loads an agent with exactly ${EXTENDS_MAX_DEPTH} extends hops (max allowed)`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-load-agent-"))
    try {
      // a0 → a1 → … → a5 (5 hops = EXTENDS_MAX_DEPTH)
      for (let i = 1; i <= EXTENDS_MAX_DEPTH; i++) {
        await writeAgentMd(workspace, `a${i}`)
      }
      // Build the chain backwards so each parent exists before child
      for (let i = EXTENDS_MAX_DEPTH - 1; i >= 1; i--) {
        await rm(join(workspace, ".agents", `a${i}`, "AGENT.md"))
        await writeAgentMd(workspace, `a${i}`, { extends: `a${i + 1}` })
      }
      const rootPath = await writeAgentMd(workspace, "a0", { extends: "a1" })
      await expect(loadAgent(rootPath, { workspace })).resolves.toMatchObject({
        handle: { id: "a0" },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it(`rejects a chain of depth ${EXTENDS_MAX_DEPTH + 1} (one beyond the limit)`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-load-agent-"))
    try {
      // a0 → a1 → … → a6 (6 hops, exceeds limit of 5)
      const OVER = EXTENDS_MAX_DEPTH + 1
      for (let i = 1; i <= OVER; i++) {
        await writeAgentMd(workspace, `a${i}`)
      }
      for (let i = OVER - 1; i >= 1; i--) {
        await rm(join(workspace, ".agents", `a${i}`, "AGENT.md"))
        await writeAgentMd(workspace, `a${i}`, { extends: `a${i + 1}` })
      }
      const rootPath = await writeAgentMd(workspace, "a0", { extends: "a1" })
      await expect(loadAgent(rootPath, { workspace })).rejects.toThrow(
        "exceeds maximum depth",
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("rejects a direct cycle A → B → A", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-load-agent-"))
    try {
      await writeAgentMd(workspace, "agent-b", { extends: "agent-a" })
      const pathA = await writeAgentMd(workspace, "agent-a", {
        extends: "agent-b",
      })
      await expect(loadAgent(pathA, { workspace })).rejects.toThrow(
        "circular extends chain",
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("rejects a longer cycle A → B → C → A", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-load-agent-"))
    try {
      await writeAgentMd(workspace, "cc", { extends: "aa" })
      await writeAgentMd(workspace, "bb", { extends: "cc" })
      const pathA = await writeAgentMd(workspace, "aa", { extends: "bb" })
      await expect(loadAgent(pathA, { workspace })).rejects.toThrow(
        "circular extends chain",
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("stops gracefully when a parent ref cannot be resolved (unresolvable = chain end)", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-load-agent-"))
    try {
      const path = await writeAgentMd(workspace, "orphan", {
        extends: "missing-parent",
      })
      // No error — unresolvable refs are treated as chain ends per spec
      await expect(loadAgent(path, { workspace })).resolves.toMatchObject({
        handle: { id: "orphan" },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("infers workspace from path when opts.workspace is not provided", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-load-agent-"))
    try {
      // Path is absolute and follows standard layout — no explicit workspace needed
      const path = await writeAgentMd(workspace, "inferred")
      await expect(loadAgent(path)).resolves.toMatchObject({
        handle: { id: "inferred" },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  describe("execution-path contract (gateway buildAgent pattern)", () => {
    // Verifies that a buildAgent-style function — i.e. the pattern used in
    // playground/scripts/gateway.ts — rejects an agent with an invalid extends
    // chain BEFORE any agent logic runs, satisfying AIP-42 T2c.
    async function buildAgentForExecution(
      agentId: string,
      workspace: string,
    ): Promise<{ handle: { id: string } }> {
      const manifestPath = join(workspace, ".agents", agentId, "AGENT.md")
      const { handle } = await loadAgent(manifestPath, { workspace })
      return { handle }
    }

    it("rejects execution of an agent with a cyclic extends chain", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "agentproto-exec-cycle-"))
      try {
        await writeAgentMd(workspace, "beta", { extends: "alpha" })
        await writeAgentMd(workspace, "alpha", { extends: "beta" })
        await expect(buildAgentForExecution("alpha", workspace)).rejects.toThrow(
          "circular extends chain",
        )
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    })

    it("rejects execution of an agent whose extends chain exceeds max depth", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "agentproto-exec-depth-"))
      try {
        const OVER = EXTENDS_MAX_DEPTH + 1
        for (let i = 1; i <= OVER; i++) {
          await writeAgentMd(workspace, `d${i}`)
        }
        for (let i = OVER - 1; i >= 1; i--) {
          await rm(join(workspace, ".agents", `d${i}`, "AGENT.md"))
          await writeAgentMd(workspace, `d${i}`, { extends: `d${i + 1}` })
        }
        await writeAgentMd(workspace, "d0", { extends: "d1" })
        await expect(buildAgentForExecution("d0", workspace)).rejects.toThrow(
          "exceeds maximum depth",
        )
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    })

    it("allows execution of an agent with a valid extends chain", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "agentproto-exec-valid-"))
      try {
        await writeAgentMd(workspace, "parent")
        await writeAgentMd(workspace, "child", { extends: "parent" })
        await expect(buildAgentForExecution("child", workspace)).resolves.toMatchObject({
          handle: { id: "child" },
        })
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    })
  })
})

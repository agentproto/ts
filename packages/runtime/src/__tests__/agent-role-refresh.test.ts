/**
 * Unit tests for `agent-role-refresh.ts` — the pure fingerprint/diff half of
 * AIP-42 hot role refresh. Registry-level wiring (`refreshAgentRole`,
 * `setAgentRoleWatch`) is covered by `agent-role-refresh-registry.test.ts`.
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  computeAgentRoleRefresh,
  fingerprintAgentRole,
  renderRoleUpdateNotice,
} from "../agent-role-refresh.js"

/** Write a minimal valid AGENT.md to `dir/<id>/AGENT.md`, body given verbatim. */
async function writeAgentMd(workspace: string, id: string, body: string): Promise<string> {
  const dir = join(workspace, ".agents", id)
  await mkdir(dir, { recursive: true })
  const source = [
    "---",
    "schema: agent/v1",
    `id: ${id}`,
    `description: Agent ${id}`,
    "model: test-model",
    "---",
    "",
    body,
  ].join("\n")
  const path = join(dir, "AGENT.md")
  await writeFile(path, source, "utf8")
  return path
}

describe("fingerprintAgentRole", () => {
  it("is deterministic for identical input", () => {
    const a = fingerprintAgentRole({ instructions: "You are helpful.", tools: ["read_file"] })
    const b = fingerprintAgentRole({ instructions: "You are helpful.", tools: ["read_file"] })
    expect(a).toEqual(b)
  })

  it("role hash changes when the text changes", () => {
    const a = fingerprintAgentRole({ instructions: "You are helpful." })
    const b = fingerprintAgentRole({ instructions: "You are sarcastic." })
    expect(a.roleHash).not.toBe(b.roleHash)
  })

  it("prefers systemPrompt over instructions for the role hash", () => {
    const a = fingerprintAgentRole({ systemPrompt: "channel text", instructions: "prefix text" })
    const b = fingerprintAgentRole({ systemPrompt: "channel text" })
    expect(a.roleHash).toBe(b.roleHash)
  })

  it("tools hash is insensitive to declaration order", () => {
    const a = fingerprintAgentRole({ tools: ["b_tool", "a_tool"] })
    const b = fingerprintAgentRole({ tools: ["a_tool", "b_tool"] })
    expect(a.toolsHash).toBe(b.toolsHash)
  })

  it("tools hash changes when the tool set changes", () => {
    const a = fingerprintAgentRole({ tools: ["a_tool"] })
    const b = fingerprintAgentRole({ tools: ["a_tool", "b_tool"] })
    expect(a.toolsHash).not.toBe(b.toolsHash)
  })

  it("role hash is independent of the tools list", () => {
    const a = fingerprintAgentRole({ instructions: "same text", tools: ["a_tool"] })
    const b = fingerprintAgentRole({ instructions: "same text", tools: ["b_tool", "c_tool"] })
    expect(a.roleHash).toBe(b.roleHash)
    expect(a.toolsHash).not.toBe(b.toolsHash)
  })
})

describe("computeAgentRoleRefresh", () => {
  let workspace: string

  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true })
  })

  it("reports no change with no previous fingerprint (establishes a baseline)", async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-role-refresh-"))
    const path = await writeAgentMd(workspace, "coach", "You are a coach.")
    const result = await computeAgentRoleRefresh({ agentManifestPath: path, adapter: "claude-code" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.roleChanged).toBe(false)
    expect(result.toolsChanged).toBe(false)
    expect(result.roleText).toBeUndefined()
  })

  it("detects a role-text edit and returns the new text", async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-role-refresh-"))
    const path = await writeAgentMd(workspace, "coach", "You are a coach.")
    const baseline = await computeAgentRoleRefresh({ agentManifestPath: path, adapter: "claude-code" })
    expect(baseline.ok).toBe(true)
    if (!baseline.ok) return

    await writeAgentMd(workspace, "coach", "You are a stern coach now.")
    const refreshed = await computeAgentRoleRefresh({
      agentManifestPath: path,
      adapter: "claude-code",
      previousRoleHash: baseline.roleHash,
      previousToolsHash: baseline.toolsHash,
    })
    expect(refreshed.ok).toBe(true)
    if (!refreshed.ok) return
    expect(refreshed.roleChanged).toBe(true)
    expect(refreshed.toolsChanged).toBe(false)
    expect(refreshed.roleText).toContain("stern coach")
  })

  it("reports no change when the file is re-read unmodified", async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-role-refresh-"))
    const path = await writeAgentMd(workspace, "coach", "You are a coach.")
    const baseline = await computeAgentRoleRefresh({ agentManifestPath: path, adapter: "claude-code" })
    expect(baseline.ok).toBe(true)
    if (!baseline.ok) return

    const again = await computeAgentRoleRefresh({
      agentManifestPath: path,
      adapter: "claude-code",
      previousRoleHash: baseline.roleHash,
      previousToolsHash: baseline.toolsHash,
    })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.roleChanged).toBe(false)
    expect(again.toolsChanged).toBe(false)
  })

  it("returns a typed error for an unreadable manifest path", async () => {
    const result = await computeAgentRoleRefresh({
      agentManifestPath: "/nonexistent/AGENT.md",
      adapter: "claude-code",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("agent_manifest_unreadable")
  })
})

describe("renderRoleUpdateNotice", () => {
  it("tells the agent not to reply to the user and carries the new text", () => {
    const text = renderRoleUpdateNotice("Be a pirate.")
    expect(text).toContain("Do not reply to the user")
    expect(text).toContain("Be a pirate.")
  })
})

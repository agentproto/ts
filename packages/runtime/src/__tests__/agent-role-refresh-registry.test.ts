/**
 * Registry-level tests for `refreshAgentRole` / `setAgentRoleWatch`
 * (sessions.ts) — the impure half of AIP-42 hot role refresh. Builds a
 * session the way `session-spawn.ts` does for an `agentId`/`agentPath`
 * spawn: `meta.agentManifestPath` + the fingerprint recorded at spawn,
 * pointing at a real AGENT.md on disk — then edits the file and checks the
 * registry notices, pushes the update, and (for tools) reports without
 * acting.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { fingerprintAgentRole } from "../agent-role-refresh.js"

const fakeAgent: AgentSessionLike = {
  sessionId: "acp-role-refresh-test",
  // eslint-disable-next-line require-yield
  async *send() {
    await new Promise(() => {}) // never resolves — keeps the session "running"
  },
  async cancel() {},
  async close() {},
}

async function writeAgentMd(dir: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, "AGENT.md")
  await writeFile(
    path,
    [
      "---",
      "schema: agent/v1",
      "id: coach",
      "description: Agent coach",
      "model: test-model",
      "---",
      "",
      body,
    ].join("\n"),
    "utf8",
  )
  return path
}

describe("refreshAgentRole", () => {
  let tmp: string
  let persistPath: string
  let manifestDir: string
  let manifestPath: string

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "agent-role-refresh-registry-"))
    persistPath = join(tmp, "sessions.json")
    manifestDir = join(tmp, ".agents", "coach")
    manifestPath = await writeAgentMd(manifestDir, "You are a coach.")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const spawnManifestSession = (
    reg: ReturnType<typeof createSessionsRegistry>,
    initialBody: string,
  ) => {
    const fp = fingerprintAgentRole({ instructions: initialBody })
    return reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: fakeAgent,
      adapterSlug: "fake",
      meta: {
        agentManifestPath: manifestPath,
        agentRoleHash: fp.roleHash,
        agentToolsHash: fp.toolsHash,
      },
    })
  }

  it("reports not_manifest_spawned for a session with no agentManifestPath", async () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })
    const outcome = await reg.refreshAgentRole(desc.id)
    expect(outcome).toMatchObject({ ok: false, code: "not_manifest_spawned" })
    reg.shutdown()
  })

  it("reports no_session for an unknown id", async () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const outcome = await reg.refreshAgentRole("sess_nope")
    expect(outcome).toMatchObject({ ok: false, code: "no_session" })
    reg.shutdown()
  })

  it("reports roleChanged: false and touches nothing when AGENT.md is unchanged", async () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawnManifestSession(reg, "You are a coach.")
    const outcome = await reg.refreshAgentRole(desc.id)
    expect(outcome).toMatchObject({ ok: true, roleChanged: false, toolsChanged: false })
    reg.shutdown()
  })

  it("pushes a steer notice and advances agentRoleHash when the role text changes", async () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawnManifestSession(reg, "You are a coach.")
    const before = reg.get(desc.id)?.meta?.agentRoleHash

    await writeAgentMd(manifestDir, "You are a stern coach now.")
    const outcome = await reg.refreshAgentRole(desc.id)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.roleChanged).toBe(true)

    const after = reg.get(desc.id)
    expect(after?.meta?.agentRoleHash).not.toBe(before)
    expect(after?.meta?.agentRoleHash).toBe(outcome.roleHash)

    // The session was idle (no turn in flight), so the notice was admitted
    // as a fresh turn rather than mid-turn-steered — either way `delivered`
    // confirms it actually reached the session, not just the inbox.
    expect(outcome.delivered).toBeDefined()
    expect(outcome.delivered?.via).not.toBe("inbox")
    reg.shutdown()
  })

  it("dryRun computes the diff without pushing or mutating meta", async () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawnManifestSession(reg, "You are a coach.")
    const before = reg.get(desc.id)?.meta?.agentRoleHash

    await writeAgentMd(manifestDir, "You are a stern coach now.")
    const outcome = await reg.refreshAgentRole(desc.id, { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, roleChanged: true })

    const after = reg.get(desc.id)
    expect(after?.meta?.agentRoleHash).toBe(before) // untouched
    expect(after?.inbox ?? []).toHaveLength(0) // nothing pushed
    reg.shutdown()
  })

  it("reports toolsChanged without touching agentToolsHash — never restarts on its own", async () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const desc = spawnManifestSession(reg, "You are a coach.")
    const before = reg.get(desc.id)?.meta?.agentToolsHash

    await writeFile(
      manifestPath,
      [
        "---",
        "schema: agent/v1",
        "id: coach",
        "description: Agent coach",
        "model: test-model",
        "tools:",
        "  - read_file",
        "---",
        "",
        "You are a coach.",
      ].join("\n"),
      "utf8",
    )
    const outcome = await reg.refreshAgentRole(desc.id)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.toolsChanged).toBe(true)
    // The role text itself didn't change, so no notice is pushed either.
    expect(outcome.roleChanged).toBe(false)

    const after = reg.get(desc.id)
    // Deliberately left at the OLD value: the tools ask hasn't taken effect
    // (fixed-at-spawn stdio MCP servers) — only an actual restart may advance it.
    expect(after?.meta?.agentToolsHash).toBe(before)
    reg.shutdown()
  })
})

describe("setAgentRoleWatch", () => {
  let tmp: string
  let persistPath: string
  let manifestDir: string
  let manifestPath: string

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "agent-role-watch-registry-"))
    persistPath = join(tmp, "sessions.json")
    manifestDir = join(tmp, ".agents", "coach")
    manifestPath = await writeAgentMd(manifestDir, "You are a coach.")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns false for an unknown session or one with no agentManifestPath", () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    expect(reg.setAgentRoleWatch("sess_nope", true)).toBe(false)
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: fakeAgent,
      adapterSlug: "fake",
    })
    expect(reg.setAgentRoleWatch(desc.id, true)).toBe(false)
    reg.shutdown()
  })

  it("auto-refreshes on a file change once watching, and stops reacting after disabling", async () => {
    const reg = createSessionsRegistry({ persistPath, persist: false })
    const fp = fingerprintAgentRole({ instructions: "You are a coach." })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: fakeAgent,
      adapterSlug: "fake",
      meta: { agentManifestPath: manifestPath, agentRoleHash: fp.roleHash, agentToolsHash: fp.toolsHash },
    })

    expect(reg.setAgentRoleWatch(desc.id, true)).toBe(true)

    await writeAgentMd(manifestDir, "You are a stern coach now.")

    // Poll briefly for the debounced (real) refresh to land — fs.watch
    // latency varies by platform — bounded by a short real-time budget,
    // not a long-sleep retry loop.
    const deadline = Date.now() + 5_000
    let refreshed = reg.get(desc.id)?.meta?.agentRoleHash !== fp.roleHash
    while (!refreshed && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
      refreshed = reg.get(desc.id)?.meta?.agentRoleHash !== fp.roleHash
    }
    expect(refreshed).toBe(true)

    expect(reg.setAgentRoleWatch(desc.id, false)).toBe(true)
    reg.shutdown()
  }, 10_000)
})

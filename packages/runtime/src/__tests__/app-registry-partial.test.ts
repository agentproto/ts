/**
 * A registry file written by an older or foreign writer (the pre-fix CLI
 * `app install` wrote a bare `{appId, dir, dataDir}`) must load without
 * poisoning anything: partial records are normalized, reported via
 * `listIssues`, healed from the app dir, and never crash an unrelated run.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineApp } from "@agentproto/app"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { createAppRegistry } from "../app-registry.js"
import { repairIncompleteApps, resolveAgentRefsForWorkflow } from "../app-tools.js"

let root: string
let persistPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "app-reg-partial-"))
  persistPath = join(root, "apps.json")
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function emitApp(id: string, dir: string, workflowId: string): Promise<void> {
  await defineApp({
    id,
    name: id,
    agents: [
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "worker",
          description: "A worker agent.",
          model: "claude-sonnet-5",
          workflows: [{ ref: workflowId }],
        }),
        body: "You do the thing.",
      },
    ],
    workflows: [
      defineWorkflow({
        id: workflowId,
        name: workflowId,
        description: "Does a thing.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [{ id: "s", kind: "tool", tool: "known_tool" }],
      }),
    ],
  }).emit(dir)
}

describe("app registry: partial / malformed records", () => {
  it("loads a bare {appId, dir, dataDir} record with defaulted refs and reports it", async () => {
    await writeFile(
      persistPath,
      JSON.stringify({ apps: [{ appId: "@t/bare", dir: join(root, "gone"), dataDir: join(root, "gone", "data") }] }),
    )
    const reg = createAppRegistry({ persistPath })
    const app = reg.getApp("@t/bare")!
    expect(app.workflows).toEqual([])
    expect(app.agents).toEqual([])
    expect(app.unvalidatedAgentTools).toEqual([])
    expect(app.dataDir).toBe(join(root, "gone", "data"))
    expect(reg.listIssues()).toEqual([
      { kind: "incomplete", appId: "@t/bare", dir: join(root, "gone"), problems: ["missing agents", "missing workflows"] },
      { kind: "dir-missing", appId: "@t/bare", dir: join(root, "gone"), problems: [`dir no longer exists: ${join(root, "gone")}`] },
    ])
  })

  it("drops records that cannot be keyed and reports them instead of throwing", async () => {
    await writeFile(persistPath, JSON.stringify({ apps: [null, "x", { dir: "/x" }, { appId: "@t/nodir" }] }))
    const reg = createAppRegistry({ persistPath })
    expect(reg.listApps()).toEqual([])
    expect(reg.listIssues().map(i => [i.kind, i.appId, i.problems])).toEqual([
      ["dropped", null, ["record is not an object"]],
      ["dropped", null, ["record is not an object"]],
      ["dropped", null, ["missing appId"]],
      ["dropped", "@t/nodir", ["missing dir"]],
    ])
  })

  it("a clean registry reports no issues, and re-installing clears a flagged record", async () => {
    await writeFile(persistPath, JSON.stringify({ apps: [{ appId: "@t/bare", dir: root }] }))
    const reg = createAppRegistry({ persistPath })
    expect(reg.listIssues()).toHaveLength(1)
    reg.upsertApp({ appId: "@t/bare", dir: root, agents: [], workflows: [], unvalidatedAgentTools: [] })
    expect(reg.listIssues()).toEqual([])
    expect(createAppRegistry({ persistPath }).listIssues()).toEqual([])
  })

  it("one app's bad record does not break workflow-ref resolution for other apps", async () => {
    const goodDir = join(root, "good")
    await emitApp("@t/good", goodDir, "good-wf")
    const reg = createAppRegistry({ persistPath })
    reg.upsertApp({
      appId: "@t/good",
      dir: goodDir,
      agents: [{ id: "worker", path: join(goodDir, ".agentproto/agents/worker/AGENT.md") }],
      workflows: [{ id: "good-wf", path: join(goodDir, ".agentproto/workflows/good-wf/WORKFLOW.md") }],
      unvalidatedAgentTools: [],
    })
    // Hand-poison the file the way the old CLI did, then reload.
    const file = JSON.parse(await readFile(persistPath, "utf8")) as { apps: unknown[] }
    file.apps.unshift({ appId: "@t/bare", dir: join(root, "bare"), dataDir: join(root, "bare", "data") })
    await writeFile(persistPath, JSON.stringify(file))

    const reloaded = createAppRegistry({ persistPath })
    const refs = await resolveAgentRefsForWorkflow(reloaded, "good-wf")
    expect(Object.keys(refs ?? {})).toEqual(["worker"])
    await expect(resolveAgentRefsForWorkflow(reloaded, "some-other-wf")).resolves.toBeUndefined()
  })

  it("repairIncompleteApps re-resolves a bare record from its app dir and keeps its dataDir", async () => {
    const dir = join(root, "app")
    await emitApp("@t/fx", dir, "do-thing")
    await writeFile(persistPath, JSON.stringify({ apps: [{ appId: "@t/fx", dir, dataDir: join(root, "custom-data") }] }))
    const reg = createAppRegistry({ persistPath })
    expect(reg.getApp("@t/fx")!.workflows).toEqual([])

    const repaired = await repairIncompleteApps(reg, async () => [])
    expect(repaired).toEqual(["@t/fx"])
    expect(reg.listIssues()).toEqual([])
    const healed = reg.getApp("@t/fx")!
    expect(healed.workflows.map(w => w.id)).toEqual(["do-thing"])
    expect(healed.agents.map(a => a.id)).toEqual(["worker"])
    expect(healed.dataDir).toBe(join(root, "custom-data"))
    const onDisk = JSON.parse(await readFile(persistPath, "utf8")) as { apps: { workflows: unknown[] }[] }
    expect(onDisk.apps[0]!.workflows).toHaveLength(1)
  })

  it("repairIncompleteApps leaves a record whose dir is gone flagged", async () => {
    await writeFile(persistPath, JSON.stringify({ apps: [{ appId: "@t/lost", dir: join(root, "missing") }] }))
    const reg = createAppRegistry({ persistPath })
    expect(await repairIncompleteApps(reg, async () => [])).toEqual([])
    expect(reg.listIssues().map(i => i.kind)).toEqual(["incomplete", "dir-missing"])
  })
})

// Incident 2026-10-24: an app installed from a PR worktree (app_install
// upserts the global record by appId) kept pointing at that worktree after
// it was removed, and workflow_run_file then failed with a bare
// "has no adapter" error that hid the missing AGENT.md.
describe("app registry: installed app whose dir was removed", () => {
  async function installThenRemove(): Promise<{ reg: ReturnType<typeof createAppRegistry>; dir: string }> {
    const dir = join(root, "worktree", "packages", "apps", "fx")
    await emitApp("@t/fx", dir, "maintain")
    const reg = createAppRegistry({ persistPath })
    reg.upsertApp({
      appId: "@t/fx",
      dir,
      agents: [{ id: "worker", path: join(dir, ".agentproto/agents/worker/AGENT.md") }],
      workflows: [{ id: "maintain", path: join(dir, ".agentproto/workflows/maintain/WORKFLOW.md") }],
      unvalidatedAgentTools: [],
    })
    expect(reg.listIssues()).toEqual([])
    await rm(join(root, "worktree"), { recursive: true, force: true })
    return { reg, dir }
  }

  it("listIssues reports it live as dir-missing, without a daemon restart", async () => {
    const { reg, dir } = await installThenRemove()
    expect(reg.listIssues()).toEqual([
      { kind: "dir-missing", appId: "@t/fx", dir, problems: [`dir no longer exists: ${dir}`] },
    ])
  })

  it("resolveAgentRefsForWorkflow names the unreadable AGENT.md and the gone dir, not a missing adapter", async () => {
    const { reg, dir } = await installThenRemove()
    const err = await resolveAgentRefsForWorkflow(reg, "maintain").then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).not.toMatch(/has no adapter/)
    expect(err!.message).toContain('agent "worker": could not read AGENT.md')
    expect(err!.message).toMatch(/ENOENT/)
    expect(err!.message).toContain(`installed app dir "${dir}" no longer exists`)
    expect(err!.message).toContain('re-run app_install for "@t/fx"')
  })
})

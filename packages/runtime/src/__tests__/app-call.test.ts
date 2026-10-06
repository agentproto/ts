import { describe, it, expect, vi } from "vitest"
import { createAppRegistry, type InstalledApp } from "../app-registry.js"
import { performAppCall } from "../app-tools.js"
import type { WorkflowRunner } from "../workflow-runner.js"

function app(over: Partial<InstalledApp> & { appId: string }): Omit<InstalledApp, "installedAt"> {
  return {
    dir: "/tmp/x",
    dataDir: "/tmp/x-data",
    agents: [],
    workflows: [],
    unvalidatedAgentTools: [],
    ...over,
  } as Omit<InstalledApp, "installedAt">
}

function setup(opts: { callerWorkflows?: string[]; callerVersion?: string; providerVersion?: string } = {}) {
  const reg = createAppRegistry({ persist: false })
  reg.upsertApp(
    app({
      appId: "@t/consumer",
      requires: ["@t/provider"],
      requiresApps: [
        {
          id: "@t/provider",
          ...(opts.callerVersion !== undefined ? { version: opts.callerVersion } : {}),
          workflows: opts.callerWorkflows ?? ["do-it"],
        },
      ],
    }),
  )
  reg.upsertApp(
    app({
      appId: "@t/provider",
      version: opts.providerVersion ?? "1.2.0",
      workflows: [{ id: "do-it", path: "/tmp/p/do-it/WORKFLOW.md" }],
      exposes: { agents: [], workflows: ["do-it"] },
    }),
  )
  return reg
}

function runner(statuses: Array<Record<string, unknown>>) {
  let i = 0
  const startFromFile = vi.fn(async () => ({ runId: "run_1" }))
  const status = vi.fn(() => statuses[Math.min(i++, statuses.length - 1)])
  return { startFromFile, status } as unknown as WorkflowRunner & {
    startFromFile: ReturnType<typeof vi.fn>
    status: ReturnType<typeof vi.fn>
  }
}

const call = { callerAppId: "@t/consumer", appId: "@t/provider", workflow: "do-it" }

describe("performAppCall", () => {
  it("runs the provider workflow and returns its output", async () => {
    const r = runner([{ status: "done", output: { text: "hi" } }])
    const res = await performAppCall(setup(), { ...call, input: { a: 1 } }, { workflowRunner: r })
    expect(res).toMatchObject({ ok: true, output: { text: "hi" }, runId: "run_1" })
    expect(r.startFromFile).toHaveBeenCalledWith({
      path: "/tmp/p/do-it/WORKFLOW.md",
      input: { a: 1 },
      appId: "@t/provider",
    })
  })

  it("caller-not-installed", async () => {
    const res = await performAppCall(setup(), { ...call, callerAppId: "@t/ghost" }, { workflowRunner: runner([]) })
    expect(res).toMatchObject({ ok: false, errorCode: "caller-not-installed" })
  })

  it("not-declared when the caller never required the provider", async () => {
    const res = await performAppCall(setup(), { ...call, appId: "@t/other" }, { workflowRunner: runner([]) })
    expect(res).toMatchObject({ ok: false, errorCode: "not-declared" })
  })

  it("workflow-not-allowed when the dependency allowlist omits the workflow", async () => {
    const res = await performAppCall(
      setup({ callerWorkflows: ["something-else"] }),
      call,
      { workflowRunner: runner([]) },
    )
    expect(res).toMatchObject({ ok: false, errorCode: "workflow-not-allowed" })
  })

  it("provider-not-installed", async () => {
    const reg = createAppRegistry({ persist: false })
    reg.upsertApp(
      app({ appId: "@t/consumer", requiresApps: [{ id: "@t/provider", workflows: ["do-it"] }] }),
    )
    const res = await performAppCall(reg, call, { workflowRunner: runner([]) })
    expect(res).toMatchObject({ ok: false, errorCode: "provider-not-installed" })
  })

  it("workflow-not-exposed when the provider does not list the workflow", async () => {
    const reg = setup()
    reg.upsertApp(app({ appId: "@t/provider", version: "1.2.0", exposes: { agents: [], workflows: [] } }))
    const res = await performAppCall(reg, call, { workflowRunner: runner([]) })
    expect(res).toMatchObject({ ok: false, errorCode: "workflow-not-exposed" })
  })

  it("version-mismatch when the installed provider is outside the declared range", async () => {
    const res = await performAppCall(
      setup({ callerVersion: "^2", providerVersion: "1.2.0" }),
      call,
      { workflowRunner: runner([]) },
    )
    expect(res).toMatchObject({ ok: false, errorCode: "version-mismatch" })
  })

  it("version-mismatch (fail closed) when the provider has no recorded version", async () => {
    const reg = setup({ callerVersion: "^1" })
    reg.upsertApp(
      app({
        appId: "@t/provider",
        workflows: [{ id: "do-it", path: "/tmp/p/do-it/WORKFLOW.md" }],
        exposes: { agents: [], workflows: ["do-it"] },
      }),
    )
    const res = await performAppCall(reg, call, { workflowRunner: runner([]) })
    expect(res).toMatchObject({ ok: false, errorCode: "version-mismatch" })
  })

  it("accepts a provider inside the declared range", async () => {
    const r = runner([{ status: "done", output: "ok" }])
    const res = await performAppCall(setup({ callerVersion: "^1.1", providerVersion: "1.2.0" }), call, {
      workflowRunner: r,
    })
    expect(res.ok).toBe(true)
  })

  it("not-enabled without a workflow runner", async () => {
    const res = await performAppCall(setup(), call, {})
    expect(res).toMatchObject({ ok: false, errorCode: "not-enabled" })
  })

  it("workflow-failed when the run ends failed", async () => {
    const r = runner([{ status: "failed", error: "boom" }])
    const res = await performAppCall(setup(), call, { workflowRunner: r })
    expect(res).toMatchObject({ ok: false, errorCode: "workflow-failed" })
    expect((res as { error: string }).error).toContain("boom")
  })

  it("workflow-failed when the run cannot start", async () => {
    const r = runner([])
    r.startFromFile.mockRejectedValueOnce(new Error("bad input"))
    const res = await performAppCall(setup(), call, { workflowRunner: r })
    expect(res).toMatchObject({ ok: false, errorCode: "workflow-failed" })
  })

  it("timeout when the run does not finish in time", async () => {
    const r = runner([{ status: "running" }])
    const res = await performAppCall(setup(), { ...call, timeoutMs: 1 }, { workflowRunner: r })
    expect(res).toMatchObject({ ok: false, errorCode: "timeout" })
  })
})

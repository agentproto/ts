import { describe, expect, it } from "vitest"

import type { InstalledAppInfo } from "../client/types.js"
import { describeWorkflowRun, parseWorkflowInput, resolveAppPanelRoute, workflowPickItems } from "./apps.logic.js"

describe("parseWorkflowInput", () => {
  it("treats blank as no input", () => {
    expect(parseWorkflowInput(undefined)).toEqual({ ok: true })
    expect(parseWorkflowInput("")).toEqual({ ok: true })
    expect(parseWorkflowInput("   ")).toEqual({ ok: true })
  })

  it("accepts a JSON object", () => {
    expect(parseWorkflowInput(' {"topic": "x", "n": 2} ')).toEqual({
      ok: true,
      input: { topic: "x", n: 2 },
    })
  })

  it("rejects malformed JSON with a message", () => {
    const res = parseWorkflowInput("{topic: x}")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/^Not valid JSON/)
  })

  it("rejects JSON that is not an object", () => {
    for (const raw of ['"str"', "42", "null", "[1,2]"]) {
      const res = parseWorkflowInput(raw)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toMatch(/JSON object/)
    }
  })
})

describe("workflowPickItems", () => {
  const apps: InstalledAppInfo[] = [
    {
      appId: "@x/a",
      name: "App A",
      workflows: [
        { id: "one", path: "/a/one/WORKFLOW.md" },
        { id: "two", path: "/a/two/WORKFLOW.md" },
      ],
    },
    { appId: "@x/b", workflows: [{ id: "three", path: "/b/three/WORKFLOW.md" }] },
    { appId: "@x/none" },
  ]

  it("flattens every app's workflows, describing each with the app name or id", () => {
    const items = workflowPickItems(apps)
    expect(items.map(i => [i.label, i.description])).toEqual([
      ["one", "App A"],
      ["two", "App A"],
      ["three", "@x/b"],
    ])
    expect(items[2]!.app.appId).toBe("@x/b")
    expect(items[2]!.ref.path).toBe("/b/three/WORKFLOW.md")
  })

  it("is empty when no app bundles a workflow", () => {
    expect(workflowPickItems([{ appId: "@x/none" }])).toEqual([])
  })
})

describe("describeWorkflowRun", () => {
  it("names the run when the daemon returned one", () => {
    expect(describeWorkflowRun("wf", { runId: "run_1", status: "running" })).toBe(
      'Workflow "wf" started — run run_1 (running).',
    )
  })

  it("degrades gracefully without a run id", () => {
    expect(describeWorkflowRun("wf", undefined)).toBe('Workflow "wf" started.')
  })
})

describe("resolveAppPanelRoute", () => {
  const withUi: InstalledAppInfo = { appId: "@x/a", ui: { path: "ui.html" } }
  const withoutUi: InstalledAppInfo = { appId: "@x/builtin" }

  it("routes to srcdoc regardless of ui when the setting is srcdoc", () => {
    expect(resolveAppPanelRoute(withUi, "srcdoc")).toBe("srcdoc")
    expect(resolveAppPanelRoute(withoutUi, "srcdoc")).toBe("srcdoc")
  })

  it("routes to iframe when the setting is iframe AND the app has a ui block", () => {
    expect(resolveAppPanelRoute(withUi, "iframe")).toBe("iframe")
  })

  it("falls back to srcdoc when the setting is iframe but the app has no ui block (e.g. a builtin)", () => {
    expect(resolveAppPanelRoute(withoutUi, "iframe")).toBe("srcdoc")
  })
})

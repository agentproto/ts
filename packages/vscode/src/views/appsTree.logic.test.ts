import { describe, expect, it } from "vitest"

import type { AppCatalogEntry, InstalledAppInfo } from "../client/types.js"
import {
  appCategory,
  appChildren,
  appContextValue,
  appDescription,
  appHasChildren,
  appLabel,
  appManifestPath,
  appsWithUi,
  appTooltip,
  categoryDescription,
  categoryLabel,
  DEFAULT_APP_CATEGORY,
  groupAppsByCategory,
  manifestDocumentName,
  nodeManifestPath,
  withCatalogCategories,
} from "./appsTree.logic.js"

function app(over: Partial<InstalledAppInfo> = {}): InstalledAppInfo {
  return { appId: "mail-triage", ...over }
}

function catalog(over: Partial<AppCatalogEntry> & { appId: string }): AppCatalogEntry {
  return { dir: `/apps/${over.appId}`, installed: true, hasUi: false, ...over }
}

describe("appsWithUi", () => {
  it("keeps only apps that ship a ui block", () => {
    const withUi = app({ appId: "with-ui", ui: { path: "/apps/ui.html" } })
    const without = app({ appId: "agents-only" })
    expect(appsWithUi([withUi, without])).toEqual([withUi])
  })

  it("returns empty for an empty registry", () => {
    expect(appsWithUi([])).toEqual([])
  })
})

describe("withCatalogCategories", () => {
  it("stamps the catalog's category onto the matching installed app", () => {
    const apps = [app({ appId: "@a/code-team" }), app({ appId: "@a/mail" })]
    const out = withCatalogCategories(apps, [
      catalog({ appId: "@a/code-team", category: "team" }),
      catalog({ appId: "@a/mail", category: "app" }),
    ])
    expect(out.map(a => a.category)).toEqual(["team", "app"])
  })

  it("leaves apps the catalog doesn't list (or lists without a category) untouched", () => {
    const apps = [app({ appId: "@a/unknown" }), app({ appId: "@a/blank" })]
    const out = withCatalogCategories(apps, [catalog({ appId: "@a/blank", category: "  " })])
    expect(out).toEqual(apps)
    expect(out[0]!.category).toBeUndefined()
  })

  it("does not override a category the app record already carries", () => {
    const out = withCatalogCategories(
      [app({ appId: "@a/x", category: "lab" })],
      [catalog({ appId: "@a/x", category: "team" })],
    )
    expect(out[0]!.category).toBe("lab")
  })

  it("does not mutate the input apps", () => {
    const original = app({ appId: "@a/x" })
    withCatalogCategories([original], [catalog({ appId: "@a/x", category: "team" })])
    expect(original.category).toBeUndefined()
  })
})

describe("appCategory / categoryLabel", () => {
  it("falls back to the default category", () => {
    expect(appCategory(app())).toBe(DEFAULT_APP_CATEGORY)
    expect(appCategory(app({ category: "  " }))).toBe("app")
  })

  it("normalizes case and whitespace", () => {
    expect(appCategory(app({ category: " Team " }))).toBe("team")
  })

  it("labels the known categories and capitalizes the rest", () => {
    expect(categoryLabel("app")).toBe("Apps")
    expect(categoryLabel("team")).toBe("Teams")
    expect(categoryLabel("lab")).toBe("Lab")
  })
})

describe("groupAppsByCategory", () => {
  it("groups by category, apps first then teams then others alphabetically", () => {
    const groups = groupAppsByCategory([
      app({ appId: "@a/zeta", category: "zeta" }),
      app({ appId: "@a/team", category: "team" }),
      app({ appId: "@a/plain" }),
      app({ appId: "@a/beta", category: "beta" }),
    ])
    expect(groups.map(g => g.category)).toEqual(["app", "team", "beta", "zeta"])
  })

  it("sorts apps within a group by label", () => {
    const groups = groupAppsByCategory([
      app({ appId: "@a/z", name: "Zulu" }),
      app({ appId: "@a/m", ui: { path: "p", title: "Alpha Panel" } }),
      app({ appId: "@a/b", name: "Bravo" }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.apps.map(a => a.appId)).toEqual(["@a/m", "@a/b", "@a/z"])
    expect(categoryDescription(groups[0]!)).toBe("3")
  })

  it("keeps agent/workflow-only apps in the tree", () => {
    const groups = groupAppsByCategory([
      app({ appId: "@a/ui", ui: { path: "p" } }),
      app({ appId: "@a/no-ui", agents: [{ id: "x", path: "/x/AGENT.md" }] }),
    ])
    expect(groups[0]!.apps.map(a => a.appId).sort()).toEqual(["@a/no-ui", "@a/ui"])
  })

  it("returns no groups for an empty registry", () => {
    expect(groupAppsByCategory([])).toEqual([])
  })
})

describe("appLabel", () => {
  it("prefers the ui title, then the app name, then the appId", () => {
    expect(appLabel(app({ name: "Named", ui: { path: "p", title: "Mail Triage" } }))).toBe("Mail Triage")
    expect(appLabel(app({ name: "Named", ui: { path: "p" } }))).toBe("Named")
    expect(appLabel(app({ name: "  " }))).toBe("mail-triage")
    expect(appLabel(app({ ui: { path: "p", title: "  " } }))).toBe("mail-triage")
  })
})

describe("appDescription", () => {
  it("prefers the ui description, then the app's own, then empty", () => {
    expect(
      appDescription(app({ description: "app desc", ui: { path: "p", description: "ui desc" } })),
    ).toBe("ui desc")
    expect(appDescription(app({ description: "app desc", ui: { path: "p" } }))).toBe("app desc")
    expect(appDescription(app({ ui: { path: "p" } }))).toBe("")
  })
})

describe("appTooltip", () => {
  it("lists identity, dir, and bundle counts", () => {
    const tip = appTooltip(
      app({
        appId: "@a/x",
        version: "0.1.0",
        dir: "/apps/x",
        agents: [{ id: "a", path: "/a" }],
        workflows: [
          { id: "w1", path: "/w1" },
          { id: "w2", path: "/w2" },
        ],
        ui: { path: "p" },
      }),
    )
    expect(tip.split("\n")).toEqual(["@a/x v0.1.0", "/apps/x", "1 agent · 2 workflows · UI panel"])
  })

  it("copes with a bare record", () => {
    expect(appTooltip(app({ appId: "@a/x" }))).toBe("@a/x\n0 agents · 0 workflows")
  })
})

describe("appContextValue", () => {
  it("only apps with a ui get the panel menu", () => {
    expect(appContextValue(app({ ui: { path: "p" } }))).toBe("app")
    expect(appContextValue(app())).toBe("app-no-ui")
  })
})

describe("appChildren / appHasChildren", () => {
  const rich = app({
    appId: "@a/x",
    agents: [
      { id: "@a/implementer", path: "/x/.agentproto/agents/implementer/AGENT.md" },
      { id: "@a/reviewer", path: "/x/.agentproto/agents/reviewer/AGENT.md" },
    ],
    workflows: [{ id: "deliver", path: "/x/.agentproto/workflows/deliver/WORKFLOW.md" }],
  })

  it("lists agents then workflows, each labelled by id and pointing at its manifest", () => {
    const children = appChildren(rich)
    expect(children.map(c => [c.kind, c.ref.id])).toEqual([
      ["agent", "@a/implementer"],
      ["agent", "@a/reviewer"],
      ["workflow", "deliver"],
    ])
    expect(children.every(c => c.app === rich)).toBe(true)
    expect(nodeManifestPath(children[0]!)).toBe("/x/.agentproto/agents/implementer/AGENT.md")
    expect(nodeManifestPath(children[2]!)).toBe("/x/.agentproto/workflows/deliver/WORKFLOW.md")
    expect(appHasChildren(rich)).toBe(true)
  })

  it("is empty for a record without agents or workflows", () => {
    expect(appChildren(app())).toEqual([])
    expect(appHasChildren(app())).toBe(false)
    expect(appHasChildren(app({ agents: [], workflows: [] }))).toBe(false)
  })
})

describe("manifest paths", () => {
  it("derives APP.md from the install dir, tolerating a trailing slash", () => {
    expect(appManifestPath(app({ dir: "/Users/me/.agentproto/apps/code-team" }))).toBe(
      "/Users/me/.agentproto/apps/code-team/.agentproto/APP.md",
    )
    expect(appManifestPath(app({ dir: "/apps/x/" }))).toBe("/apps/x/.agentproto/APP.md")
    expect(nodeManifestPath({ kind: "app", app: app({ dir: "/apps/x" }) })).toBe("/apps/x/.agentproto/APP.md")
  })

  it("is undefined without a dir, and for structural rows", () => {
    expect(appManifestPath(app())).toBeUndefined()
    expect(nodeManifestPath({ kind: "empty" })).toBeUndefined()
    expect(nodeManifestPath({ kind: "category", category: "app", apps: [] })).toBeUndefined()
  })

  it("names manifest documents per app so tabs don't collide", () => {
    const a = app({ appId: "@a/x" })
    expect(manifestDocumentName({ kind: "app", app: a })).toBe("@a/x/APP.md")
    expect(manifestDocumentName({ kind: "agent", app: a, ref: { id: "@a/r", path: "/p" } })).toBe(
      "@a/x/agents/@a/r/AGENT.md",
    )
    expect(manifestDocumentName({ kind: "workflow", app: a, ref: { id: "wf", path: "/p" } })).toBe(
      "@a/x/workflows/wf/WORKFLOW.md",
    )
  })
})

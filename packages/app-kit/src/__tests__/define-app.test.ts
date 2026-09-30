import { describe, it, expect } from "vitest"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { defineWorkspace } from "@agentproto/workspace"
import { defineApp, AppDefinitionError } from "../define-app.js"

function agent(id: string, workflows: { ref: string }[] = [{ ref: "review-and-fix" }]) {
  return defineAgent({
    schema: "agent/v1",
    id,
    description: `Agent ${id} bundled with its workflow.`,
    model: "claude-sonnet-5",
    workflows,
  })
}

function reviewWorkflow(id = "review-and-fix") {
  return defineWorkflow({
    id,
    name: "Review and fix",
    description: "Read the diff, report findings.",
    version: "0.1.0",
    inputs: {},
    outputs: {},
    steps: [{ id: "review", kind: "tool", tool: "read_diff" }],
  })
}

describe("defineApp — multi-agent + attachment invariant", () => {
  it("builds a frozen handle when agents ⇄ workflows match", () => {
    const app = defineApp({
      agents: [
        { agent: agent("@agentik/reviewer"), body: "You review." },
        { agent: agent("@agentik/fixer") }, // body optional
      ],
      workflows: [reviewWorkflow()],
    })
    expect(app.agents).toHaveLength(2)
    expect(app.agents[0]!.body).toBe("You review.")
    expect(app.agents[1]!.body).toBeUndefined()
    expect(Object.isFrozen(app)).toBe(true)
    expect(Object.isFrozen(app.agents)).toBe(true)
  })

  it("accepts a bare AgentHandle in agents[] (no body)", () => {
    const app = defineApp({
      agents: [agent("solo", [])],
    })
    expect(app.agents).toHaveLength(1)
    expect(app.agents[0]!.agent.id).toBe("solo")
  })

  it("carries attachments (any AIP handle) verbatim", () => {
    const company = { id: "acme", schema: "agentcompanies/v1" }
    const app = defineApp({
      agents: [agent("solo", [])],
      attach: [company],
    })
    expect(app.attachments).toEqual([company])
  })

  it("throws on an empty agents array", () => {
    expect(() => defineApp({ agents: [] })).toThrow(AppDefinitionError)
  })

  it("throws on a duplicate agent id", () => {
    expect(() =>
      defineApp({ agents: [agent("dup", []), agent("dup", [])] }),
    ).toThrow(/duplicate agent id/i)
  })

  it("throws when an agent references a workflow the app does not bundle", () => {
    expect(() =>
      defineApp({
        agents: [{ agent: agent("rev", [{ ref: "ghost" }]) }],
        workflows: [reviewWorkflow()],
      }),
    ).toThrow(AppDefinitionError)
  })

  it("throws when a bundled workflow is referenced by no agent (orphan)", () => {
    expect(() =>
      defineApp({
        agents: [agent("rev", [])],
        workflows: [reviewWorkflow()],
      }),
    ).toThrow(/no agent lists it/i)
  })

  it("accepts a workflow referenced by only one of several agents", () => {
    const app = defineApp({
      agents: [
        { agent: agent("rev", [{ ref: "review-and-fix" }]) },
        { agent: agent("bystander", []) },
      ],
      workflows: [reviewWorkflow()],
    })
    expect(app.workflows).toHaveLength(1)
  })

  it("normalizes a workspace shorthand to an AIP-34 handle with local-fs default", () => {
    const app = defineApp({
      agents: [agent("solo", [])],
      workspace: {
        id: "@acme/reviewers",
        name: "Acme Reviewers",
        owner: { type: "guild", id: "guild_123", slug: "acme" },
        // storage omitted → defaults to local-fs
      },
    })
    expect(app.workspace?.schema).toBe("workspace/v1")
    expect(app.workspace?.id).toBe("@acme/reviewers")
    expect(app.workspace?.owner.type).toBe("guild")
    expect(app.workspace?.storage).toEqual({ inline: { provider: "local-fs", config: {} } })
    expect(app.workspace?.version).toBe("0.1.0")
  })

  it("carries a pre-built defineWorkspace handle through unchanged", () => {
    const ws = defineWorkspace({
      schema: "workspace/v1",
      id: "@acme/reviewers",
      name: "Acme Reviewers",
      version: "2.0.0",
      owner: { type: "org", id: "org_1", slug: "acme" },
      storage: { inline: { provider: "github", config: {} } },
    })
    const app = defineApp({ agents: [agent("solo", [])], workspace: ws })
    expect(app.workspace).toBe(ws)
    expect(app.workspace?.version).toBe("2.0.0")
  })

  it("has no workspace when none is declared", () => {
    const app = defineApp({ agents: [agent("solo", [])] })
    expect(app.workspace).toBeUndefined()
  })

  it("rejects a malformed workspace shorthand with the AIP-34 diagnostic", () => {
    expect(() =>
      defineApp({
        agents: [agent("solo", [])],
        workspace: {
          id: "no-owner-segment", // fails the @<owner>/<ws> id pattern
          name: "Bad",
          owner: { type: "guild", id: "g", slug: "acme" },
        },
      }),
    ).toThrow(/defineWorkspace \(AIP-34\)/)
  })

  it("carries optional app identity through to the handle, defaulting version when id is set", () => {
    const app = defineApp({
      agents: [agent("solo", [])],
      id: "@acme/reviewers-app",
      name: "Reviewers",
      description: "A reviewer app.",
    })
    expect(app.id).toBe("@acme/reviewers-app")
    expect(app.name).toBe("Reviewers")
    expect(app.version).toBe("0.1.0")
    expect(app.description).toBe("A reviewer app.")
  })

  it("keeps an explicit version instead of the default when id is set", () => {
    const app = defineApp({ agents: [agent("solo", [])], id: "app-1", version: "2.3.0" })
    expect(app.version).toBe("2.3.0")
  })

  it("leaves id/name/version/description undefined when none is given", () => {
    const app = defineApp({ agents: [agent("solo", [])] })
    expect(app.id).toBeUndefined()
    expect(app.name).toBeUndefined()
    expect(app.version).toBeUndefined()
    expect(app.description).toBeUndefined()
  })

  it("throws on an empty (but present) app id", () => {
    expect(() => defineApp({ agents: [agent("solo", [])], id: "  " })).toThrow(AppDefinitionError)
  })

  it("carries ui/artifact/artifacts/dev/skill through to the handle, frozen", () => {
    const app = defineApp({
      agents: [agent("solo", [])],
      ui: {
        html: "<html><body>Hi</body></html>",
        title: "Solo Panel",
        tools: ["read_file"],
        csp: { connectDomains: ["api.example.com"] },
      },
      artifact: { path: "/tmp/artifact.html", title: "Dashboard", description: "A dashboard." },
      skill: { path: "/tmp/skill-dir", title: "My Skill", description: "A test skill." },
      artifacts: [{ type: "report", description: "A generated report." }],
      dev: {
        launch: [{ name: "dev", runtimeExecutable: "node", runtimeArgs: ["server.js"], port: 3000 }],
      },
    })
    expect(app.ui?.title).toBe("Solo Panel")
    expect(app.ui?.tools).toEqual(["read_file"])
    expect(app.ui?.csp).toEqual({ connectDomains: ["api.example.com"] })
    expect(app.artifact?.path).toBe("/tmp/artifact.html")
    expect(app.artifact?.title).toBe("Dashboard")
    expect(app.artifact?.description).toBe("A dashboard.")
    expect(app.skill?.path).toBe("/tmp/skill-dir")
    expect(app.skill?.title).toBe("My Skill")
    expect(app.skill?.description).toBe("A test skill.")
    expect(app.artifacts).toEqual([{ type: "report", description: "A generated report." }])
    expect(app.dev?.launch).toEqual([
      { name: "dev", runtimeExecutable: "node", runtimeArgs: ["server.js"], port: 3000 },
    ])
    expect(Object.isFrozen(app.ui)).toBe(true)
    expect(Object.isFrozen(app.artifact)).toBe(true)
    expect(Object.isFrozen(app.skill)).toBe(true)
    expect(Object.isFrozen(app.artifacts)).toBe(true)
    expect(Object.isFrozen(app.artifacts![0])).toBe(true)
    expect(Object.isFrozen(app.dev)).toBe(true)
    expect(Object.isFrozen(app.dev!.launch)).toBe(true)
    expect(Object.isFrozen(app.dev!.launch[0])).toBe(true)
  })

  it("throws when ui.html is missing or empty", () => {
    expect(() =>
      defineApp({ agents: [agent("solo", [])], ui: { html: "" } }),
    ).toThrow(/ui\.html/)
    expect(() =>
      defineApp({ agents: [agent("solo", [])], ui: { html: "   " } }),
    ).toThrow(/ui\.html/)
  })

  it("throws when dev.launch is present but empty", () => {
    expect(() =>
      defineApp({ agents: [agent("solo", [])], dev: { launch: [] } }),
    ).toThrow(/dev\.launch/)
  })

  it("throws when artifact.path is missing or empty", () => {
    expect(() =>
      defineApp({ agents: [agent("solo", [])], artifact: { path: "" } }),
    ).toThrow(/artifact\.path/)
    expect(() =>
      defineApp({ agents: [agent("solo", [])], artifact: { path: "   " } }),
    ).toThrow(/artifact\.path/)
  })

  it("throws when skill.path is missing or empty", () => {
    expect(() =>
      defineApp({ agents: [agent("solo", [])], skill: { path: "" } }),
    ).toThrow(/skill\.path/)
    expect(() =>
      defineApp({ agents: [agent("solo", [])], skill: { path: "   " } }),
    ).toThrow(/skill\.path/)
  })

  it("leaves ui/artifact/artifacts/dev/skill undefined when none given", () => {
    const app = defineApp({ agents: [agent("solo", [])] })
    expect(app.ui).toBeUndefined()
    expect(app.artifact).toBeUndefined()
    expect(app.skill).toBeUndefined()
    expect(app.artifacts).toBeUndefined()
    expect(app.dev).toBeUndefined()
  })

  it("matches string and { ref } workflow refs by the same key", () => {
    const app = defineApp({
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "reviewer",
            description: "Uses a bare-string workflow ref.",
            model: "claude-sonnet-5",
            workflows: ["review-and-fix"],
          }),
        },
      ],
      workflows: [reviewWorkflow()],
    })
    expect(app.workflows[0]!.id).toBe("review-and-fix")
  })
})

describe("defineApp — UI-only apps (zero agents)", () => {
  it("accepts an explicit empty agents array when ui is present", () => {
    const app = defineApp({ agents: [], ui: { html: "<html></html>" } })
    expect(app.agents).toEqual([])
    expect(app.ui?.html).toBe("<html></html>")
  })

  it("accepts agents omitted entirely when ui is present", () => {
    const app = defineApp({ ui: { html: "<html></html>" } })
    expect(app.agents).toEqual([])
    expect(app.ui?.html).toBe("<html></html>")
  })

  it("throws when agents is empty and ui is absent", () => {
    expect(() => defineApp({ agents: [] })).toThrow(AppDefinitionError)
    expect(() => defineApp({ agents: [] })).toThrow(/at least one agent.*ui.*block/i)
  })

  it("throws when both agents and ui are omitted", () => {
    expect(() => defineApp({})).toThrow(AppDefinitionError)
    expect(() => defineApp({})).toThrow(/at least one agent.*ui.*block/i)
  })

  it("still defaults version to 0.1.0 for a UI-only app with an id", () => {
    const app = defineApp({ id: "@acme/ui-only", ui: { html: "<html></html>" } })
    expect(app.version).toBe("0.1.0")
  })

  it("toMastraAgent throws on a zero-agent app", async () => {
    const app = defineApp({ ui: { html: "<html></html>" } })
    await expect(app.toMastraAgent({ resolveModel: () => { throw new Error("unreachable") } })).rejects.toThrow(
      AppDefinitionError,
    )
  })

  it("toMastraAgents resolves to an empty object on a zero-agent app", async () => {
    const app = defineApp({ ui: { html: "<html></html>" } })
    await expect(
      app.toMastraAgents({ resolveModel: () => { throw new Error("unreachable") } }),
    ).resolves.toEqual({})
  })

  it("pick([]) returns [] and pick with an unknown id still throws", () => {
    const app = defineApp({ ui: { html: "<html></html>" } })
    expect(app.pick([])).toEqual([])
    expect(() => app.pick(["missing"])).toThrow(/not in this app/)
  })
})

describe("defineApp — data dir hint", () => {
  it("carries `data.dir` through to the handle, frozen", () => {
    const app = defineApp({ agents: [agent("solo", [])], data: { dir: "data" } })
    expect(app.data).toEqual({ dir: "data" })
    expect(Object.isFrozen(app.data)).toBe(true)
  })

  it("is absent when not declared", () => {
    expect(defineApp({ agents: [agent("solo", [])] }).data).toBeUndefined()
  })

  it("throws when data.dir is empty", () => {
    expect(() => defineApp({ agents: [agent("solo", [])], data: { dir: "" } })).toThrow(/data\.dir/)
    expect(() => defineApp({ agents: [agent("solo", [])], data: { dir: "   " } })).toThrow(/data\.dir/)
  })
})

describe("defineApp — category", () => {
  it("carries category through to the handle", () => {
    const app = defineApp({ agents: [agent("solo", [])], category: "widget" })
    expect(app.category).toBe("widget")
  })

  it("is absent when not declared", () => {
    expect(defineApp({ agents: [agent("solo", [])] }).category).toBeUndefined()
  })

  it("throws when category is empty", () => {
    expect(() => defineApp({ agents: [agent("solo", [])], category: "" })).toThrow(/category/)
    expect(() => defineApp({ agents: [agent("solo", [])], category: "   " })).toThrow(/category/)
  })
})

describe("defineApp — absolute artifact.path / skill.path (AIP-53 rule 7)", () => {
  it("accepts absolute paths on both fields", () => {
    expect(() =>
      defineApp({
        agents: [agent("solo", [])],
        artifact: { path: "/abs/artifact/index.html" },
        skill: { path: "/abs/skills/my-skill" },
      }),
    ).not.toThrow()
  })

  it("rejects a relative artifact.path, naming the field and the value", () => {
    expect(() =>
      defineApp({ agents: [agent("solo", [])], artifact: { path: "artifact/index.html" } }),
    ).toThrow(AppDefinitionError)
    expect(() =>
      defineApp({ agents: [agent("solo", [])], artifact: { path: "artifact/index.html" } }),
    ).toThrow(/`artifact\.path`.*absolute.*artifact\/index\.html/)
  })

  it("rejects a relative skill.path, naming the field and the value", () => {
    expect(() =>
      defineApp({ agents: [agent("solo", [])], skill: { path: "skills/my-skill" } }),
    ).toThrow(AppDefinitionError)
    expect(() =>
      defineApp({ agents: [agent("solo", [])], skill: { path: "skills/my-skill" } }),
    ).toThrow(/`skill\.path`.*absolute.*skills\/my-skill/)
  })
})

describe("defineApp — ui.extensions.openai v1 contract", () => {
    const solo = () =>
      defineAgent({
        schema: "agent/v1" as const,
        id: "solo",
        description: "Solo agent with a ui.",
        model: "claude-sonnet-5",
        workflows: [],
      })
    type AppDef = NonNullable<Parameters<typeof defineApp>[0]>
    const app = (ui: Record<string, unknown>) =>
      defineApp({ agents: [{ agent: solo(), body: "Solo." }], ui } as unknown as AppDef)

  const fileEntry = (extensions: readonly string[]) => ({ type: "file", extensions })
  const openai = (ext: Record<string, unknown>) => ({ extensions: { openai: ext } })
  const extension = (openaiExt: Record<string, unknown>, tools: string[] = ["dossier_list"]) => ({
    html: "<html><body>Panel</body></html>",
    tools,
    ...openai(openaiExt),
  })

  it("app-without-openai-extension-is-unchanged", async () => {
    const plain = { html: "<html><body>Panel</body></html>", title: "Panel", tools: ["dossier_list"] }
    const handle = app(plain)
    expect(handle.ui).toEqual({ ...plain })
    expect(handle.ui).toMatchObject({ title: "Panel", tools: ["dossier_list"] })
    expect(Object.isFrozen(handle.ui)).toBe(true)
  })

  it("file-entrypoint-validates-dot-extensions", async () => {
    for (const [input, output] of [
      // valid: lowercase normalization preserves the same set
      [[".md", ".STL"], [".md", ".stl"]],
      [[".pdf"], [".pdf"]],
    ] as const) {
      const handle = app(extension({ entrypoints: [{ type: "global" }, fileEntry([...input])] }))
      const eps = (handle.ui!.extensions as { openai: { entrypoints: { type: string; extensions?: string[] }[] } }).openai.entrypoints
      expect(eps).toEqual([
        { type: "global" },
        { type: "file", extensions: [...output] },
      ])
    }
    // table-driven rejections, each naming ui.extensions.openai.entrypoints
    // with the reason the declaration cannot be advertised as-is.
    for (const [name, extensions] of [
      ["empty", []],
      ["too many", ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "aa", "bb", "cc", "dd", "ee", "ff", "gg"]],
      ["not dot-prefixed", ["md"]],
      ["starts with a symbol", [".+md"]],
      ["uppercase duplicate", [".md", ".MD"]],
      ["exact duplicate", [".md", ".md"]],
    ] as const) {
      expect(() =>
        app(extension({ entrypoints: [fileEntry(extensions as readonly string[])] })),
      ).toThrow(AppDefinitionError)
      expect(() =>
        app(extension({ entrypoints: [fileEntry(extensions as readonly string[])] })),
      ).toThrow(/ui\.extensions\.openai\.entrypoints/)
    }
  })

  it("mentions-tool-must-be-allowlisted", () => {
    expect(() =>
      app(
        extension({ mentions: { searchTool: "dossier_mentions" } } as never, ["dossier_list"]),
      ),
    ).toThrow(/ui\.extensions\.openai\.mentions\.searchTool.*'dossier_mentions'.*dossier_list/)
    // non-empty searchTool that IS in tools parses.
    const handle = app(extension({ mentions: { searchTool: "dossier_mentions" } }, ["dossier_list", "dossier_mentions"]))
    expect((handle.ui!.extensions as { openai: { mentions: { searchTool: string } } }).openai.mentions).toEqual({
      searchTool: "dossier_mentions",
    })
  })

  it("openai-display-preference-must-be-available", () => {
    expect(() =>
      app(
        extension({ display: { availableModes: ["inline"], preferredMode: "fullscreen" } }),
      ),
    ).toThrow(/ui\.extensions\.openai\.display\.preferredMode.*'fullscreen'.*availableModes/)
    expect(() =>
      app(extension({ display: { availableModes: ["inline", "fullscreen"], preferredMode: "fullscreen" } })),
    ).not.toThrow()
    // empty or duplicate mode lists fail.
    expect(() => app(extension({ display: { availableModes: [] } }))).toThrow(/availableModes.*non-empty/)
    expect(() =>
      app(extension({ display: { availableModes: ["inline", "inline"] } })),
    ).toThrow(/declares 'inline' more than once/)
  })

  it("openai-v1-rejects-unknown-extension-keys", () => {
    // Cut v1 features do not parse as "future-compatible" placeholders —
    // they fail with the exact field path so nothing is half-advertised.
    for (const [location, badObject] of [
      ["namespace: extensions only accepts openai", { forms: {} }],
      ["cut: openai.forms", { forms: {} }],
      ["cut: openai.settings", { settings: {} }],
      ["cut: openai.resources", { resources: { write: true } }],
      ["cut: openai.files", { files: { open: true } }],
      ["cut: openai.deepLinks", { deepLinks: true }],
      ["cut: openai.pluginManifest", { pluginManifest: {} }],
      ["cut: openai.elicitation", { elicitation: {} }],
      ["unknown entrypoint field", { entrypoints: [{ type: "global", audience: "user" }] }],
      ["unknown icon field", { icons: [{ src: "https://x/y.png", badge: "x" }] }],
      ["unknown mentions field", { mentions: { searchTool: "dossier_list", web: true } }],
    ] as const) {
      expect(
        () => app(extension(badObject as Record<string, unknown>)),
        location,
      ).toThrow(AppDefinitionError)
    }
  })

  it("validates entrypoint count/types and icon src rules", () => {
    expect(() => app(extension({ entrypoints: [] }))).toThrow(/1\.\.3/)
    expect(() =>
      app(
        extension({
          entrypoints: [{ type: "global" }, { type: "global" }, { type: "thread" }, { type: "file", extensions: [".md"] }],
        }),
      ),
    ).toThrow(/1\.\.3/)
    expect(() =>
      app(extension({ entrypoints: [{ type: "global" }, { type: "global" }] })),
    ).toThrow(/more than once/)
    expect(() =>
      app(extension({ entrypoints: [{ type: "window" }] })),
    ).toThrow(/"global", "thread" or "file"/)
    // icons: ≥1, HTTPS or data:image/…;base64 (inline SVG data allowed).
    expect(() => app(extension({ icons: [] }))).toThrow(/at least one icon/)
    expect(() =>
      app(extension({ icons: [{ src: "http://insecure/x.png" }] })),
    ).toThrow(/HTTPS URL or a 'data:image/)
    expect(() =>
      app(extension({ icons: [{ src: "data:image/png;base64,not base64!!" }] })),
    ).toThrow(/HTTPS URL or a 'data:image/)
    expect(() =>
      app(extension({ icons: [{ src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" }] })),
    ).not.toThrow()
    const handle = app(
      extension({
        icons: [
          { src: "data:image/svg+xml;base64,PHN2Zy8+", sizes: ["512x512"], theme: "dark" },
          { src: "https://cdn.example.com/32.png", mimeType: "image/png" },
        ],
      }),
    )
    const icons = (handle.ui!.extensions as { openai: { icons: { src: string }[] } }).openai.icons
    expect(icons).toEqual([
      { src: "data:image/svg+xml;base64,PHN2Zy8+", sizes: ["512x512"], theme: "dark" },
      { src: "https://cdn.example.com/32.png", mimeType: "image/png" },
    ])
  })

  it("freezes the whole extensions tree on the AppHandle", () => {
    const handle = app(
      extension({
        entrypoints: [fileEntry([".md"])],
        icons: [{ src: "https://cdn.example.com/32.png" }],
        display: { availableModes: ["inline"] },
        mentions: { searchTool: "dossier_list" },
      }),
    )
    const ext = (handle.ui!.extensions as unknown as Record<string, unknown>).openai as Record<string, unknown>
    expect(Object.isFrozen(handle.ui!.extensions)).toBe(true)
    expect(Object.isFrozen(ext)).toBe(true)
    expect(Object.isFrozen(ext.entrypoints)).toBe(true)
    expect(Object.isFrozen((ext.entrypoints as unknown[])[1])).toBe(true)
    expect(Object.isFrozen((ext.icons as unknown[])[0])).toBe(true)
    expect(Object.isFrozen(ext.display)).toBe(true)
    expect(Object.isFrozen(ext.mentions)).toBe(true)
  })
})

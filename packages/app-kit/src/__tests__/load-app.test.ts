import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import matter from "gray-matter"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { defineApp, AppDefinitionError } from "../define-app.js"
import { loadAppHandle, AppLoadError } from "../load-app.js"

const reviewerBody =
  "You are a rigorous reviewer.\nReport findings. Change nothing.\nNever run gh pr merge."

function buildApp(opts: { id?: string; workspace?: boolean } = {}) {
  return defineApp({
    agents: [
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "@agentik/reviewer",
          description: "A PR reviewer bundled with its review workflow.",
          model: "claude-sonnet-5",
          boundaries: ["Never run gh pr merge"],
          workflows: [{ ref: "review-and-fix" }],
        }),
        body: reviewerBody,
      },
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "fixer",
          description: "Applies a fix (no body — prompt composes).",
          model: "claude-sonnet-5",
          workflows: [{ ref: "review-and-fix" }],
        }),
      },
    ],
    workflows: [
      defineWorkflow({
        id: "review-and-fix",
        name: "Review and fix",
        description: "Read the diff, report findings.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [
          { id: "review", kind: "tool", tool: "read_diff" },
          { id: "report", kind: "tool", tool: "post_review" },
        ],
      }),
    ],
    ...(opts.workspace
      ? {
          workspace: {
            id: "@acme/reviewers",
            name: "Acme Reviewers",
            owner: { type: "guild" as const, id: "guild_123", slug: "acme" },
          },
        }
      : {}),
    ...(opts.id ? { id: opts.id, name: "Reviewer App", description: "Reviews PRs." } : {}),
  })
}

describe("loadAppHandle — the inverse of emit", () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-kit-load-"))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("round-trips defineApp → emit → loadAppHandle (ids, bodies, workflow ids)", async () => {
    const original = buildApp()
    await original.emit(dir)

    const loaded = await loadAppHandle(dir)

    expect(loaded.agents.map((e) => e.agent.id).sort()).toEqual(
      original.agents.map((e) => e.agent.id).sort(),
    )
    const reviewer = loaded.agents.find((e) => e.agent.id === "@agentik/reviewer")
    expect(reviewer?.body).toBe(reviewerBody)
    const fixer = loaded.agents.find((e) => e.agent.id === "fixer")
    expect(fixer?.body).toBeUndefined()

    expect(loaded.workflows.map((w) => w.id)).toEqual(original.workflows.map((w) => w.id))
    expect(loaded.workflows[0]!.steps.map((s) => s.id)).toEqual(
      original.workflows[0]!.steps.map((s) => s.id),
    )
    expect(loaded.workspace).toBeUndefined()
  })

  it("round-trips a declarative agent-step workflow (WP-B4): agent.ref + prompt survive emit → loadAppHandle", async () => {
    const original = defineApp({
      id: "@acme/agent-step-app",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "Does the thing.",
            model: "claude-sonnet-5",
            workflows: [{ ref: "do-thing" }],
          }),
          body: "You do the thing.",
        },
      ],
      workflows: [
        defineWorkflow({
          id: "do-thing",
          name: "Do thing",
          description: "One agent step.",
          version: "0.1.0",
          inputs: {},
          outputs: {},
          steps: [
            {
              id: "step1",
              kind: "agent",
              agent: { ref: "worker" },
              prompt: "Do the thing.",
            },
          ],
        }),
      ],
    })
    await original.emit(dir)

    const loaded = await loadAppHandle(dir)
    const step = loaded.workflows[0]!.steps[0] as unknown as {
      id: string
      kind: string
      agent?: { ref: string }
      prompt?: string
    }
    expect(step.kind).toBe("agent")
    expect(step.agent).toEqual({ ref: "worker" })
    expect(step.prompt).toBe("Do the thing.")
  })

  it("round-trips app identity (id/name/version/description) when set", async () => {
    const original = buildApp({ id: "@acme/reviewer-app" })
    await original.emit(dir)

    const loaded = await loadAppHandle(dir)
    expect(loaded.id).toBe(original.id)
    expect(loaded.name).toBe(original.name)
    expect(loaded.version).toBe(original.version)
    expect(loaded.description).toBe(original.description)
  })

  it("round-trips the home workspace", async () => {
    const original = buildApp({ workspace: true })
    await original.emit(dir)

    const loaded = await loadAppHandle(dir)
    expect(loaded.workspace?.id).toBe("@acme/reviewers")
    expect(loaded.workspace?.owner.type).toBe("guild")
  })

  it("re-validates the attachment invariant on load", async () => {
    const original = buildApp()
    const { agentPaths } = await original.emit(dir)

    // Corrupt both emitted AGENT.md files so neither lists the bundled
    // workflow anymore — APP.md still references it. The attachment
    // invariant (an orphaned bundled workflow) must catch this on load
    // exactly as a fresh defineApp() call would.
    for (const path of [agentPaths["@agentik/reviewer"]!, agentPaths["fixer"]!]) {
      const parsed = matter(await readFile(path, "utf8"))
      delete parsed.data.workflows
      await writeFile(path, matter.stringify(parsed.content, parsed.data), "utf8")
    }

    await expect(loadAppHandle(dir)).rejects.toThrow(AppDefinitionError)
    await expect(loadAppHandle(dir)).rejects.toThrow(/no agent lists it/i)
  })

  it("throws AppLoadError naming the path when APP.md is missing", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "app-kit-load-empty-"))
    try {
      await expect(loadAppHandle(emptyDir)).rejects.toThrow(AppLoadError)
      await expect(loadAppHandle(emptyDir)).rejects.toThrow(/APP\.md/)
    } finally {
      await rm(emptyDir, { recursive: true, force: true })
    }
  })

  it("throws AppLoadError naming the path when a referenced AGENT.md is missing", async () => {
    const missingDir = await mkdtemp(join(tmpdir(), "app-kit-load-missing-agent-"))
    try {
      await mkdir(join(missingDir, ".agentproto"), { recursive: true })
      await writeFile(
        join(missingDir, ".agentproto", "APP.md"),
        [
          "---",
          "schema: app/v1",
          "version: 0.1.0",
          "agents:",
          "  - id: ghost",
          "    path: .agentproto/agents/ghost/AGENT.md",
          "workflows: []",
          "---",
          "",
        ].join("\n"),
      )
      await expect(loadAppHandle(missingDir)).rejects.toThrow(AppLoadError)
      await expect(loadAppHandle(missingDir)).rejects.toThrow(/ghost/)
    } finally {
      await rm(missingDir, { recursive: true, force: true })
    }
  })

  it("throws AppLoadError on a schema mismatch in APP.md's frontmatter", async () => {
    const badDir = await mkdtemp(join(tmpdir(), "app-kit-load-bad-schema-"))
    try {
      await mkdir(join(badDir, ".agentproto"), { recursive: true })
      await writeFile(
        join(badDir, ".agentproto", "APP.md"),
        ["---", "schema: not-app/v1", "agents: []", "workflows: []", "---", ""].join("\n"),
      )
      await expect(loadAppHandle(badDir)).rejects.toThrow(AppLoadError)
      await expect(loadAppHandle(badDir)).rejects.toThrow(/app\/v1/)
    } finally {
      await rm(badDir, { recursive: true, force: true })
    }
  })

  it("round-trips requires field when present", async () => {
    const app = defineApp({
      id: "@test/dependent-app",
      name: "Dependent App",
      requires: ["@test/base-app", "@test/util-app"],
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "Worker agent.",
            model: "claude-sonnet-5",
            workflows: [{ ref: "do-thing" }],
          }),
          body: "Do the thing.",
        },
      ],
      workflows: [
        defineWorkflow({
          id: "do-thing",
          name: "Do thing",
          description: "Does a thing.",
          version: "0.1.0",
          inputs: {},
          outputs: {},
          steps: [{ id: "step1", kind: "tool", tool: "noop" }],
        }),
      ],
    })
    await app.emit(dir)

    const loaded = await loadAppHandle(dir)
    expect(loaded.requires).toEqual(["@test/base-app", "@test/util-app"])

    const appPath = join(dir, ".agentproto", "APP.md")
    const parsed = matter(await readFile(appPath, "utf8"))
    expect(parsed.data.requires).toEqual(["@test/base-app", "@test/util-app"])
  })

  it("round-trips ui: html byte-equal, tools/csp preserved", async () => {
    const html = "<html><body><h1>Panel</h1></body></html>"
    const original = defineApp({
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "solo",
            description: "Solo agent with a ui.",
            model: "claude-sonnet-5",
          }),
          body: "Solo.",
        },
      ],
      ui: {
        html,
        title: "Solo Panel",
        description: "A panel.",
        tools: ["read_file"],
        csp: { connectDomains: ["api.example.com"], resourceDomains: ["cdn.example.com"] },
      },
    })
    await original.emit(dir)

    const loaded = await loadAppHandle(dir)
    expect(loaded.ui?.html).toBe(html)
    expect(loaded.ui?.title).toBe("Solo Panel")
    expect(loaded.ui?.description).toBe("A panel.")
    expect(loaded.ui?.tools).toEqual(["read_file"])
    expect(loaded.ui?.csp).toEqual({
      connectDomains: ["api.example.com"],
      resourceDomains: ["cdn.example.com"],
    })
  })

  it("round-trips artifacts and dev", async () => {
    const original = defineApp({
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "solo",
            description: "Solo agent.",
            model: "claude-sonnet-5",
          }),
          body: "Solo.",
        },
      ],
      artifacts: [{ type: "report", description: "A generated report." }],
      dev: {
        launch: [{ name: "dev", runtimeExecutable: "node", runtimeArgs: ["server.js"], port: 3000 }],
      },
    })
    await original.emit(dir)

    const loaded = await loadAppHandle(dir)
    expect(loaded.artifacts).toEqual([{ type: "report", description: "A generated report." }])
    expect(loaded.dev?.launch).toEqual([
      { name: "dev", runtimeExecutable: "node", runtimeArgs: ["server.js"], port: 3000 },
    ])
  })

  it("throws AppLoadError when ui.path is set but the file is missing", async () => {
    const missingUiDir = await mkdtemp(join(tmpdir(), "app-kit-load-missing-ui-"))
    try {
      const app = defineApp({
        agents: [
          {
            agent: defineAgent({
              schema: "agent/v1",
              id: "solo",
              description: "Solo agent with a ui.",
              model: "claude-sonnet-5",
            }),
            body: "Solo.",
          },
        ],
        ui: { html: "<html></html>" },
      })
      const { uiPath } = await app.emit(missingUiDir)
      await rm(uiPath!, { force: true })

      await expect(loadAppHandle(missingUiDir)).rejects.toThrow(AppLoadError)
      await expect(loadAppHandle(missingUiDir)).rejects.toThrow(/ui/)
    } finally {
      await rm(missingUiDir, { recursive: true, force: true })
    }
  })

  it("throws AppLoadError when requires is not an array of strings", async () => {
    const badDir = await mkdtemp(join(tmpdir(), "app-kit-load-bad-requires-"))
    try {
      await mkdir(join(badDir, ".agentproto"), { recursive: true })
      await writeFile(
        join(badDir, ".agentproto", "APP.md"),
        ["---", "schema: app/v1", "agents: []", "workflows: []", "requires: 123", "---", ""].join("\n"),
      )
      await expect(loadAppHandle(badDir)).rejects.toThrow(AppLoadError)
      await expect(loadAppHandle(badDir)).rejects.toThrow(/requires.*array of strings/)
    } finally {
      await rm(badDir, { recursive: true, force: true })
    }
  })
})

/**
 * Tests for `scaffoldApp` (`src/scaffold.ts`) — hermetic, tmp-dir only. No
 * install, no build, no network: assert the file set, APP.md frontmatter,
 * token substitution, the `_gitignore` rename, and the non-empty-dir /
 * unknown-template refusals.
 */

import { describe, it, expect, afterEach } from "vitest"

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import matter from "gray-matter"

import { scaffoldApp } from "../scaffold.js"

const tmpRoots: string[] = []

async function mktmp(prefix = "create-agentproto-app-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
})

/** Recursively collect every file's relative path + contents under `root`. */
async function readAllFiles(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const { readdir } = await import("node:fs/promises")
  async function walk(rel: string): Promise<void> {
    const abs = join(root, rel)
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const entryRel = rel ? join(rel, entry.name) : entry.name
      if (entry.isDirectory()) {
        await walk(entryRel)
      } else if (entry.isFile()) {
        out.set(entryRel, await readFile(join(root, entryRel), "utf8"))
      }
    }
  }
  await walk("")
  return out
}

describe("template source tree", () => {
  it.each(["react-ts", "vanilla"] as const)(
    "%s ships _agentproto/ (escaped), never a literal .agentproto/",
    async (template) => {
      // The monorepo root .gitignore ignores `.agentproto/` at any depth, so a
      // dot-named template tree exists locally but silently never reaches git —
      // CI then scaffolds apps with no APP.md. The template must ship the
      // escaped name and rely on the copy-time rename in template.ts.
      const { readdir } = await import("node:fs/promises")
      const { fileURLToPath } = await import("node:url")
      const templateDir = fileURLToPath(new URL(`../../templates/${template}`, import.meta.url))
      const entries = await readdir(templateDir)
      expect(entries).toContain("_agentproto")
      expect(entries).not.toContain(".agentproto")
    },
  )
})

describe("scaffoldApp", () => {
  it("writes the frozen file set with default id/name derived from the dir basename", async () => {
    const root = await mktmp()
    const target = join(root, "My Cool App")

    const outcome = await scaffoldApp({ targetDir: target })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.slug).toBe("my-cool-app")
    expect(outcome.result.id).toBe("my-cool-app")
    expect(outcome.result.name).toBe("My Cool App")
    expect(outcome.result.template).toBe("react-ts")
    expect(outcome.result.appDir).toBe(target)
    expect(outcome.result.fileCount).toBeGreaterThan(0)

    const files = await readAllFiles(target)
    for (const expected of [
      "package.json",
      "pnpm-workspace.yaml",
      ".gitignore",
      ".agentproto/APP.md",
      ".agentproto/agents/my-cool-app-assistant/AGENT.md",
      ".agentproto/workflows/my-cool-app-flow/WORKFLOW.md",
      ".agentproto/ui/index.html",
      "ui/package.json",
      "ui/vite.config.ts",
      "ui/tsconfig.json",
      "ui/index.html",
      "ui/src/main.tsx",
      "ui/src/router.tsx",
      "ui/src/routes/dashboard.tsx",
      "ui/src/routes/about.tsx",
      "ui/src/standalone-tools.ts",
    ]) {
      expect(files.has(expected), `missing ${expected}`).toBe(true)
    }
    expect(files.has("_gitignore")).toBe(false)
  })

  it("leaves no __APP_ tokens in any written file (content or path)", async () => {
    const root = await mktmp()
    const target = join(root, "token-check")
    const outcome = await scaffoldApp({ targetDir: target, name: "Token Check" })
    expect(outcome.ok).toBe(true)

    const files = await readAllFiles(target)
    for (const [path, contents] of files) {
      expect(path, `token left in path ${path}`).not.toMatch(/__APP_(ID|NAME|SLUG|CLIENT_VERSION)__/)
      expect(contents, `token left in ${path}`).not.toMatch(/__APP_(ID|NAME|SLUG|CLIENT_VERSION)__/)
    }
  })

  it("stamps ui/package.json's @agentproto/app-client dep with the installed version", async () => {
    const root = await mktmp()
    const target = join(root, "version-stamp")
    const outcome = await scaffoldApp({ targetDir: target })
    expect(outcome.ok).toBe(true)

    const { fileURLToPath } = await import("node:url")
    const appClientPkgPath = fileURLToPath(
      new URL("../../../app-client/package.json", import.meta.url),
    )
    const appClientVersion = JSON.parse(await readFile(appClientPkgPath, "utf8")).version

    const uiPkg = JSON.parse(await readFile(join(target, "ui", "package.json"), "utf8"))
    expect(uiPkg.dependencies["@agentproto/app-client"]).toBe(`^${appClientVersion}`)
  })

  it("substitutes __APP_ID__/__APP_NAME__/__APP_SLUG__ with the resolved values", async () => {
    const root = await mktmp()
    const target = join(root, "widgets")
    const outcome = await scaffoldApp({
      targetDir: target,
      id: "@acme/widgets",
      name: "Widgets Console",
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.slug).toBe("widgets")
    expect(outcome.result.id).toBe("@acme/widgets")
    expect(outcome.result.name).toBe("Widgets Console")

    const appMd = await readFile(join(target, ".agentproto", "APP.md"), "utf8")
    expect(appMd).toContain("id: '@acme/widgets'")
    expect(appMd).toContain("name: Widgets Console")

    const rootPkg = await readFile(join(target, "package.json"), "utf8")
    expect(JSON.parse(rootPkg).name).toBe("widgets")
  })

  it("APP.md frontmatter parses via gray-matter with the right ui.path and refs", async () => {
    const root = await mktmp()
    const target = join(root, "parsed-app")
    const outcome = await scaffoldApp({ targetDir: target })
    expect(outcome.ok).toBe(true)

    const raw = await readFile(join(target, ".agentproto", "APP.md"), "utf8")
    const { data } = matter(raw)
    expect(data.schema).toBe("app/v1")
    expect(data.id).toBe("parsed-app")
    expect(data.ui.path).toBe(".agentproto/ui/index.html")
    expect(data.agents[0].id).toBe("parsed-app-assistant")
    expect(data.agents[0].path).toBe(
      ".agentproto/agents/parsed-app-assistant/AGENT.md",
    )
    expect(data.workflows[0].id).toBe("parsed-app-flow")
    expect(data.workflows[0].path).toBe(
      ".agentproto/workflows/parsed-app-flow/WORKFLOW.md",
    )
  })

  it("AGENT.md and WORKFLOW.md frontmatter parse and cross-reference each other", async () => {
    const root = await mktmp()
    const target = join(root, "cross-ref")
    const outcome = await scaffoldApp({ targetDir: target })
    expect(outcome.ok).toBe(true)

    const agentRaw = await readFile(
      join(target, ".agentproto", "agents", "cross-ref-assistant", "AGENT.md"),
      "utf8",
    )
    const agent = matter(agentRaw).data
    expect(agent.schema).toBe("agent/v1")
    expect(agent.id).toBe("cross-ref-assistant")
    expect(agent.workflows[0].ref).toBe("cross-ref-flow")

    const workflowRaw = await readFile(
      join(target, ".agentproto", "workflows", "cross-ref-flow", "WORKFLOW.md"),
      "utf8",
    )
    const workflow = matter(workflowRaw).data
    expect(workflow.id).toBe("cross-ref-flow")
    expect(workflow.steps[0].agent.ref).toBe("cross-ref-assistant")
  })

  it("refuses a non-empty target dir", async () => {
    const root = await mktmp()
    const target = join(root, "occupied")
    await mkdir(target, { recursive: true })
    await writeFile(join(target, "keep.txt"), "already here", "utf8")

    const outcome = await scaffoldApp({ targetDir: target })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe("target-not-empty")

    const files = await readAllFiles(target)
    expect([...files.keys()]).toEqual(["keep.txt"])
  })

  it("accepts an existing but empty target dir", async () => {
    const root = await mktmp()
    const target = join(root, "empty-preexisting")
    await mkdir(target, { recursive: true })

    const outcome = await scaffoldApp({ targetDir: target })
    expect(outcome.ok).toBe(true)
  })

  it("refuses an unknown --template", async () => {
    const root = await mktmp()
    const target = join(root, "bad-template")

    const outcome = await scaffoldApp({ targetDir: target, template: "vue-ts" })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe("unknown-template")
  })
})

describe("scaffoldApp with --template vanilla", () => {
  it("writes the frozen vanilla file set — no ui/, no root package.json", async () => {
    const root = await mktmp()
    const target = join(root, "vanilla-app")

    const outcome = await scaffoldApp({ targetDir: target, template: "vanilla" })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.template).toBe("vanilla")

    const files = await readAllFiles(target)
    for (const expected of [
      ".gitignore",
      ".agentproto/APP.md",
      ".agentproto/agents/vanilla-app-assistant/AGENT.md",
      ".agentproto/workflows/vanilla-app-flow/WORKFLOW.md",
      ".agentproto/ui/index.html",
    ]) {
      expect(files.has(expected), `missing ${expected}`).toBe(true)
    }
    expect(files.has("_gitignore")).toBe(false)
    expect(files.has("package.json")).toBe(false)
    expect(files.has("pnpm-workspace.yaml")).toBe(false)
    expect(files.has("ui/package.json")).toBe(false)
    for (const path of files.keys()) {
      expect(path.startsWith("ui/"), `unexpected ui/ file ${path}`).toBe(false)
    }
  })

  it("leaves no __APP_ tokens in any written file (content or path)", async () => {
    const root = await mktmp()
    const target = join(root, "vanilla-token-check")
    const outcome = await scaffoldApp({
      targetDir: target,
      template: "vanilla",
      name: "Vanilla Token Check",
    })
    expect(outcome.ok).toBe(true)

    const files = await readAllFiles(target)
    for (const [path, contents] of files) {
      expect(path, `token left in path ${path}`).not.toMatch(/__APP_(ID|NAME|SLUG|CLIENT_VERSION)__/)
      expect(contents, `token left in ${path}`).not.toMatch(/__APP_(ID|NAME|SLUG|CLIENT_VERSION)__/)
    }
  })

  it("APP.md frontmatter parses via gray-matter", async () => {
    const root = await mktmp()
    const target = join(root, "vanilla-parsed")
    const outcome = await scaffoldApp({ targetDir: target, template: "vanilla" })
    expect(outcome.ok).toBe(true)

    const raw = await readFile(join(target, ".agentproto", "APP.md"), "utf8")
    const { data } = matter(raw)
    expect(data.schema).toBe("app/v1")
    expect(data.id).toBe("vanilla-parsed")
    expect(data.ui.path).toBe(".agentproto/ui/index.html")
  })

  // The CLI behavior of `app build` no-opping is covered in
  // packages/cli/src/__tests__/app-build.test.ts — this just asserts the
  // scaffolded shape it depends on (no ui/package.json to build).
  it("has no ui/package.json, so `app build` will no-op against it", async () => {
    const root = await mktmp()
    const target = join(root, "vanilla-buildless")
    const outcome = await scaffoldApp({ targetDir: target, template: "vanilla" })
    expect(outcome.ok).toBe(true)

    const files = await readAllFiles(target)
    expect(files.has("ui/package.json")).toBe(false)
  })
})

/**
 * `peekAppUi` — resolves APP.md frontmatter's `ui.path` + `ui.build`
 * WITHOUT reading the ui html itself, so a caller (the daemon's
 * `performInstall`, `agentproto app serve`) can run a declared `ui.build`
 * step BEFORE `loadAppHandle` would otherwise throw on a missing bundle.
 */

import { describe, it, expect, afterEach } from "vitest"

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { peekAppUi, AppLoadError } from "../load-app.js"

const tmpRoots: string[] = []

async function mkApp(frontmatter: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "peek-app-ui-"))
  tmpRoots.push(dir)
  await mkdir(join(dir, ".agentproto"), { recursive: true })
  await writeFile(join(dir, ".agentproto", "APP.md"), `---\n${frontmatter}---\n`, "utf8")
  return dir
}

afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
})

describe("peekAppUi", () => {
  it("returns undefined when ui is absent", async () => {
    const dir = await mkApp("schema: app/v1\nagents:\n  - id: a\n    path: AGENT.md\n")
    expect(await peekAppUi(dir)).toBeUndefined()
  })

  it("returns undefined for a missing APP.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peek-app-ui-"))
    tmpRoots.push(dir)
    expect(await peekAppUi(dir)).toBeUndefined()
  })

  it("resolves ui.path without a build block, without reading the html", async () => {
    const dir = await mkApp("schema: app/v1\nui:\n  path: ui/index.html\n")
    // The referenced html does not exist on disk — peekAppUi never reads it.
    expect(await peekAppUi(dir)).toEqual({ path: join(dir, "ui", "index.html") })
  })

  it("resolves ui.build alongside ui.path", async () => {
    const dir = await mkApp(
      "schema: app/v1\n" +
        "ui:\n" +
        "  path: .agentproto/ui/index.html\n" +
        "  build:\n" +
        "    command: pnpm run build\n" +
        "    cwd: ui\n" +
        "    sources:\n" +
        "      - ui/src/**\n",
    )
    expect(await peekAppUi(dir)).toEqual({
      path: join(dir, ".agentproto", "ui", "index.html"),
      build: { command: "pnpm run build", cwd: "ui", sources: ["ui/src/**"] },
    })
  })

  it("throws AppLoadError when ui.path is missing or not a string", async () => {
    const noPath = await mkApp("schema: app/v1\nui:\n  port: 8123\n")
    await expect(peekAppUi(noPath)).rejects.toBeInstanceOf(AppLoadError)
  })

  it("throws AppLoadError when ui.build.command is missing or empty", async () => {
    const noCommand = await mkApp("schema: app/v1\nui:\n  path: ui/index.html\n  build:\n    cwd: ui\n")
    await expect(peekAppUi(noCommand)).rejects.toBeInstanceOf(AppLoadError)

    const emptyCommand = await mkApp(
      "schema: app/v1\nui:\n  path: ui/index.html\n  build:\n    command: ''\n",
    )
    await expect(peekAppUi(emptyCommand)).rejects.toBeInstanceOf(AppLoadError)
  })

  it("throws AppLoadError when ui.build.sources isn't an array of non-empty strings", async () => {
    const dir = await mkApp(
      "schema: app/v1\nui:\n  path: ui/index.html\n  build:\n    command: x\n    sources: not-an-array\n",
    )
    await expect(peekAppUi(dir)).rejects.toBeInstanceOf(AppLoadError)
  })

  it("honours an absolute ui.path", async () => {
    const dir = await mkApp("schema: app/v1\nui:\n  path: /abs/ui/index.html\n")
    expect(await peekAppUi(dir)).toEqual({ path: "/abs/ui/index.html" })
  })
})

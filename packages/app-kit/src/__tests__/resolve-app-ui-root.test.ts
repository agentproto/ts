/**
 * `resolveAppUIRoot` — the UI-root resolution `app serve` shares with
 * `app_install`/`loadAppHandle`: APP.md frontmatter `ui.path` → the
 * directory CONTAINING that entry file; `ui` absent → undefined (caller
 * falls back to the legacy `.agentproto/ui/`); malformed `ui` → AppLoadError.
 */

import { describe, it, expect, afterEach } from "vitest"

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { resolveAppUIRoot, AppLoadError } from "../load-app.js"

const tmpRoots: string[] = []

async function mkApp(frontmatter: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "app-ui-root-"))
  tmpRoots.push(dir)
  await mkdir(join(dir, ".agentproto"), { recursive: true })
  await writeFile(join(dir, ".agentproto", "APP.md"), `---\n${frontmatter}---\n`, "utf8")
  return dir
}

afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
})

describe("resolveAppUIRoot", () => {
  it("resolves ui.path to the directory containing the entry file", async () => {
    const dir = await mkApp("schema: app/v1\nui:\n  path: ui/index.html\n")
    expect(await resolveAppUIRoot(dir)).toBe(join(dir, "ui"))
  })

  it("resolves the legacy .agentproto/ui layout too", async () => {
    const dir = await mkApp("schema: app/v1\nui:\n  path: .agentproto/ui/index.html\n")
    expect(await resolveAppUIRoot(dir)).toBe(join(dir, ".agentproto", "ui"))
  })

  it("returns undefined when ui is absent (caller falls back to .agentproto/ui)", async () => {
    const dir = await mkApp("schema: app/v1\nagents:\n  - id: a\n    path: AGENT.md\n")
    expect(await resolveAppUIRoot(dir)).toBeUndefined()
  })

  it("returns undefined for a missing APP.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "app-ui-root-"))
    tmpRoots.push(dir)
    expect(await resolveAppUIRoot(dir)).toBeUndefined()
  })

  it("throws AppLoadError when ui.path is missing or not a string", async () => {
    const noPath = await mkApp("schema: app/v1\nui:\n  port: 8123\n")
    await expect(resolveAppUIRoot(noPath)).rejects.toBeInstanceOf(AppLoadError)

    const badPath = await mkApp("schema: app/v1\nui:\n  path: 42\n")
    await expect(resolveAppUIRoot(badPath)).rejects.toBeInstanceOf(AppLoadError)
  })

  it("honours an absolute ui.path", async () => {
    const dir = await mkApp("schema: app/v1\nui:\n  path: /abs/ui/index.html\n")
    expect(await resolveAppUIRoot(dir)).toBe("/abs/ui")
  })
})
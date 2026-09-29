import { afterEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AgentAppPackError, aggregateSha256, packApp, unpackApp } from "../pack.js"

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})
async function mktmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "app-kit-pack-"))
  roots.push(d)
  return d
}

async function fixture(root: string): Promise<string> {
  const appDir = join(root, "demo-app")
  await mkdir(join(appDir, ".agentproto", "agents", "scout"), { recursive: true })
  await mkdir(join(appDir, "ui", "node_modules", "dep"), { recursive: true })
  await mkdir(join(appDir, "notes"), { recursive: true })
  await writeFile(
    join(appDir, ".agentproto", "APP.md"),
    `---\nid: demo-app\nname: Demo\nversion: 1.2.3\nagents:\n  - id: scout\n    path: .agentproto/agents/scout/AGENT.md\n---\n# Demo\n`,
  )
  await writeFile(join(appDir, ".agentproto", "agents", "scout", "AGENT.md"), "---\nid: scout\n---\nhi\n")
  await writeFile(join(appDir, "notes", "a.md"), "alpha\n")
  await writeFile(join(appDir, "ui", "node_modules", "dep", "x.js"), "skip me\n")
  return appDir
}

describe("packApp / unpackApp", () => {
  it("round-trips: manifest, sorted files, node_modules skipped, no manifest.json restored", async () => {
    const root = await mktmp()
    const appDir = await fixture(root)
    const out = join(root, "out", "demo.agentapp")

    const { file, manifest } = await packApp({ appDir, out })
    expect(file).toBe(out)
    expect(manifest.format).toBe("agentapp/v1")
    expect(manifest.id).toBe("demo-app")
    expect(manifest.version).toBe("1.2.3")
    expect(manifest.agents).toEqual(["scout"])
    expect(manifest.files).toEqual([...manifest.files].sort())
    expect(manifest.files).toContain("notes/a.md")
    expect(manifest.files.some((f) => f.includes("node_modules"))).toBe(false)
    expect(manifest.sha256).toBe(await aggregateSha256(appDir, manifest.files))

    const dest = join(root, "restored")
    const res = await unpackApp({ file, dest })
    expect(res.dir).toBe(dest)
    expect(res.manifest.sha256).toBe(manifest.sha256)
    expect(existsSync(join(dest, "manifest.json"))).toBe(false)
    expect(await readFile(join(dest, "notes", "a.md"), "utf8")).toBe("alpha\n")
    expect(existsSync(join(dest, "ui", "node_modules"))).toBe(false)
  })

  it("packApp rejects a dir without .agentproto/APP.md", async () => {
    const root = await mktmp()
    await expect(packApp({ appDir: root, out: join(root, "x.agentapp") })).rejects.toMatchObject({
      code: "not-an-app",
    })
  })

  it("unpackApp refuses a tampered bundle and creates nothing at dest", async () => {
    const root = await mktmp()
    const appDir = await fixture(root)
    const { file } = await packApp({ appDir, out: join(root, "demo.agentapp") })

    const scratch = join(root, "scratch")
    await mkdir(scratch)
    expect(spawnSync("tar", ["-xzf", file, "-C", scratch]).status).toBe(0)
    await writeFile(join(scratch, "notes", "a.md"), "tampered\n")
    const bad = join(root, "bad.agentapp")
    expect(spawnSync("tar", ["-czf", bad, ".agentproto", "manifest.json", "notes", "ui"], { cwd: scratch }).status).toBe(0)

    const dest = join(root, "dest")
    const err = await unpackApp({ file: bad, dest }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentAppPackError)
    expect((err as AgentAppPackError).code).toBe("digest-mismatch")
    expect(existsSync(dest)).toBe(false)
  })

  it("unpackApp refuses a manifest listing a path outside the bundle root", async () => {
    const root = await mktmp()
    const appDir = await fixture(root)
    const { file } = await packApp({ appDir, out: join(root, "demo.agentapp") })

    const scratch = join(root, "scratch")
    await mkdir(scratch)
    spawnSync("tar", ["-xzf", file, "-C", scratch])
    const manifest = JSON.parse(await readFile(join(scratch, "manifest.json"), "utf8"))
    manifest.files.push("../escape.txt")
    await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest))
    const bad = join(root, "bad.agentapp")
    spawnSync("tar", ["-czf", bad, ".agentproto", "manifest.json", "notes", "ui"], { cwd: scratch })

    await expect(unpackApp({ file: bad, dest: join(root, "dest") })).rejects.toMatchObject({ code: "unsafe-path" })
  })

  it("unpackApp reports a missing bundle and a missing manifest", async () => {
    const root = await mktmp()
    await expect(unpackApp({ file: join(root, "nope.agentapp") })).rejects.toMatchObject({ code: "bundle-not-found" })
    await mkdir(join(root, "s"))
    await writeFile(join(root, "s", "f.txt"), "x")
    const bundle = join(root, "nomanifest.agentapp")
    spawnSync("tar", ["-czf", bundle, "f.txt"], { cwd: join(root, "s") })
    await expect(unpackApp({ file: bundle, dest: join(root, "d") })).rejects.toMatchObject({ code: "missing-manifest" })
  })
})

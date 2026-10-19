/**
 * Bundled-layout resolution for the long docs: in the published
 * `@agentproto/cli` bundle the runtime (and with it `tool-help.ts`) is inlined
 * into `dist/cli.mjs`, so `packageRoot` is the CLI package root and the help
 * dir is `<root>/docs/mcp-tools` — one level above the bundle, where the cli
 * build copies the docs (tsup `onSuccess` + the `files` array). Simulate that
 * layout here: transpile the real source into `<tmp>/dist/cli.mjs`, with the
 * docs either absent or copied alongside, and read through the import.
 */

import { describe, expect, it } from "vitest"
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const sourcePath = fileURLToPath(new URL("../tool-help.ts", import.meta.url))
const shippedDocs = fileURLToPath(new URL("../../docs/mcp-tools", import.meta.url))

type BundledHelp = typeof import("../tool-help.js")

/** A fake package root with the transpiled source at `dist/cli.mjs`. */
async function makeBundle(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentproto-tool-help-bundle-"))
  const ts = require("typescript") as typeof import("typescript")
  const { outputText } = ts.transpileModule(await readFile(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  })
  await mkdir(join(root, "dist"), { recursive: true })
  await writeFile(join(root, "dist", "cli.mjs"), outputText)
  return root
}

async function importBundle(root: string, phase: string): Promise<BundledHelp> {
  const url = `${pathToFileURL(join(root, "dist", "cli.mjs")).href}?phase=${phase}`
  return (await import(/* @vite-ignore */ url)) as BundledHelp
}

describe("bundled cli.mjs layout", () => {
  it("resolves the help dir from the bundle's own package root, not the repo's", async () => {
    const root = await makeBundle()
    try {
      const mod = await importBundle(root, "no-docs")
      expect(mod.listToolHelpTopics()).toEqual([])
      expect(mod.getToolHelp("task_create")).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reads the docs copied alongside the bundle", async () => {
    const root = await makeBundle()
    try {
      await cp(shippedDocs, join(root, "docs", "mcp-tools"), { recursive: true })
      const mod = await importBundle(root, "with-docs")
      const expected = await readFile(join(shippedDocs, "task_create.md"), "utf8")
      expect(mod.getToolHelp("task_create")).toBe(expected)
      expect(mod.listToolHelpTopics()).toContain("task_create")
      expect(mod.getToolHelp("definitely_not_a_real_tool_xyz")).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

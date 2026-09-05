import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { afterEach, describe, expect, it } from "vitest"
import { defineAppConfig, type GateRule } from "../index.js"
import { runCli } from "../cli.js"

const AppSchema = z.object({
  id: z.string(),
  items: z.array(z.object({ id: z.string() })).default([]),
})

const ItemSchema = z.object({
  id: z.string(),
  title: z.string(),
})

const kit = defineAppConfig({ app: AppSchema, item: ItemSchema, itemsKey: "items" })

const CONFIG_TS = `import { z } from "zod"
import { defineAppConfig, type GateRule } from "${join(import.meta.dirname, "..", "index.ts")}"

export const kit = defineAppConfig({
  app: z.object({ id: z.string(), items: z.array(z.object({ id: z.string() })).default([]) }),
  item: z.object({ id: z.string(), title: z.string() }),
  itemsKey: "items",
})

export const rules: GateRule[] = [
  {
    id: "title-length",
    level: "error",
    test: (resolved) =>
      resolved.order
        .filter((id) => {
          const item = resolved.items.get(id)
          return item !== undefined && item.value.title.length > 20
        })
        .map((id) => ({ message: "title too long", item: id })),
  },
]

export const template = (item: { id: string; value: { title: string } }) => ({
  schema: "item-contract/v1",
  id: item.id,
  title: item.value.title,
})

export const scopes = {
  assets: () => [{ scope: "assets", level: "skipped" as const, message: "none" }],
}
`

let root: string

function setup(): string {
  root = mkdtempSync(join(tmpdir(), "app-config-cli-"))
  mkdirSync(join(root, "config/items"), { recursive: true })
  writeFileSync(join(root, "config/app.yaml"), "id: cli-app\nitems: []\n")
  writeFileSync(join(root, "config/items/doc.yaml"), "id: doc\ntitle: A Title\n")
  writeFileSync(join(root, "app.config.ts"), CONFIG_TS)
  return root
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

function capture(): { lines: string[]; log: (l: string) => void } {
  const lines: string[] = []
  return { lines, log: (l: string) => lines.push(l) }
}

describe("runCli", () => {
  it("check passes and reports the item count", async () => {
    const dir = setup()
    const { lines, log } = capture()
    const code = await runCli({ argv: ["check", "app.config.ts"], cwd: dir, log })
    expect(code).toBe(0)
    expect(lines.join("\n")).toContain("1 item(s)")
  })

  it("usage error for unknown command", async () => {
    const dir = setup()
    const { lines, log } = capture()
    const code = await runCli({ argv: ["nonsense", "app.config.ts"], cwd: dir, log })
    expect(code).toBe(2)
    expect(lines.join("\n")).toContain("usage:")
  })

  it("contracts write then --check is clean, and drift exits 1", async () => {
    const dir = setup()
    const { log: log1 } = capture()
    expect(await runCli({ argv: ["contracts", "app.config.ts"], cwd: dir, log: log1 })).toBe(0)

    const { lines: lines2, log: log2 } = capture()
    expect(await runCli({ argv: ["contracts", "--check", "app.config.ts"], cwd: dir, log: log2 })).toBe(0)
    expect(lines2.join("\n")).toContain("no drift")

    writeFileSync(join(dir, "config/items/doc.yaml"), "id: doc\ntitle: Changed Title\n")
    const { lines: lines3, log: log3 } = capture()
    expect(await runCli({ argv: ["contracts", "--check", "app.config.ts"], cwd: dir, log: log3 })).toBe(1)
    expect(lines3.join("\n")).toContain("drifted")
  })

  it("verify composes rules + contracts + scopes and exits 1 on error findings", async () => {
    const dir = setup()
    const { lines, log } = capture()
    const code = await runCli({ argv: ["verify", "app.config.ts"], cwd: dir, log })
    expect(code).toBe(1) // contracts are missing on disk → 2 error findings
    const text = lines.join("\n")
    expect(text).toContain("[contracts/error]")
    expect(text).toContain("[assets/skipped]")
    expect(text).toContain("FAILED")

    // write the contracts → verify still ok:true (warnings only? no — errors gone)
    const { log: log2 } = capture()
    await runCli({ argv: ["contracts", "app.config.ts"], cwd: dir, log: log2 })
    const { lines: lines3, log: log3 } = capture()
    expect(await runCli({ argv: ["verify", "app.config.ts"], cwd: dir, log: log3 })).toBe(0)
    expect(lines3.join("\n")).toContain("OK")
  })

  it("schema writes schema files", async () => {
    const dir = setup()
    const { lines, log } = capture()
    expect(await runCli({ argv: ["schema", "app.config.ts"], cwd: dir, log })).toBe(0)
    expect(lines.join("\n")).toContain("schemas/app.schema.json")
  })
})

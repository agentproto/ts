import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  AppConfigError,
  defineAppConfig,
  memorySource,
  type GateRule,
} from "../index.js"

const AppSchema = z.object({
  id: z.string(),
  defaults: z
    .object({ lang: z.string().default("en"), assets: z.array(z.string()).default([]) })
    .default({ lang: "en", assets: [] }),
  items: z
    .array(z.object({ id: z.string(), tier: z.string().optional() }))
    .default([]),
})

const ItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  lang: z.string().default("en"),
  assets: z.array(z.string()).default([]),
})

const kit = defineAppConfig({
  app: AppSchema,
  item: ItemSchema,
  itemsKey: "items",
  defaultsKey: "defaults",
})

const APP_YAML = `id: doc-app
defaults:
  lang: en
  assets:
    - shared/logo.png
items:
  - id: guide
    tier: pro
  - id: faq
`

const GUIDE_YAML = `id: guide
title: The Guide
assets:
  - shared/logo.png
  - guide/diagram.png
`

const FAQ_YAML = `id: faq
title: the FAQ
`

/** The SAME fixture, expressed as memory-source keys relative to root. */
const MEMORY_FILES: Record<string, string> = {
  "config/app.yaml": APP_YAML,
  "config/items/guide.yaml": GUIDE_YAML,
  "config/items/faq.yaml": FAQ_YAML,
}

function writeDiskFixture(dir: string): string {
  mkdirSync(join(dir, "config/items"), { recursive: true })
  writeFileSync(join(dir, "config/app.yaml"), APP_YAML)
  writeFileSync(join(dir, "config/items/guide.yaml"), GUIDE_YAML)
  writeFileSync(join(dir, "config/items/faq.yaml"), FAQ_YAML)
  return dir
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "app-config-source-test-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Memory source: the second resolution path the consumer can delete
// ---------------------------------------------------------------------------

describe("memory source load", () => {
  it("resolves an app entirely from a memory source — no disk — with the same Resolved shape as the disk path", () => {
    writeDiskFixture(root)
    const disk = kit.load(root)
    // the memory source is rooted at the SAME path the disk fixture occupies,
    // so the two Resolved values must be interchangeable (paths included)
    const mem = kit.load(root, { source: memorySource(MEMORY_FILES, root) })

    expect(mem.rootDir).toBe(disk.rootDir)
    expect(mem.appFile).toBe(disk.appFile)
    expect(mem.app).toEqual(disk.app)
    expect(mem.order).toEqual(disk.order)
    expect(mem.order).toEqual(["guide", "faq"])
    for (const id of mem.order) {
      expect(mem.items.get(id)).toEqual(disk.items.get(id))
    }
    // and the values are the real merged, schema-parsed values
    const guide = mem.items.get("guide")
    expect(guide?.value).toEqual({
      id: "guide",
      title: "The Guide",
      lang: "en",
      assets: ["shared/logo.png", "guide/diagram.png"],
    })
    expect(guide?.entryIndex).toBe(0)
    expect(guide?.dir).toBe(join(root, "config/items"))
  })

  it("accepts an app kit definition whose source is injected at defineAppConfig level, with per-call overriding it", () => {
    writeDiskFixture(root)
    const memKit = defineAppConfig({
      app: AppSchema,
      item: ItemSchema,
      itemsKey: "items",
      defaultsKey: "defaults",
      source: memorySource(MEMORY_FILES, "/virtual-root"),
    })
    // kit-level source: no disk involved, root is an arbitrary virtual root
    const resolved = memKit.load("/virtual-root")
    expect(resolved.order).toEqual(["guide", "faq"])
    expect(resolved.items.get("faq")?.value.lang).toBe("en")

    // per-call source wins over the kit-level one
    const perCall = memKit.load(root, { source: memorySource(MEMORY_FILES, root) })
    expect(perCall.order).toEqual(["guide", "faq"])
    expect(perCall.items.get("guide")?.itemPath).toBe(join(root, "config/items/guide.yaml"))

    // the disk path still works unchanged on a kit with a memory default source
    // (per-call source = real filesystem, the kit default)
    const diskKit = defineAppConfig({ app: AppSchema, item: ItemSchema, itemsKey: "items", defaultsKey: "defaults" })
    expect(diskKit.load(root).order).toEqual(["guide", "faq"])
  })

  it("throws kit errors (not raw fs errors) for missing files and bad yaml in a memory source", () => {
    const bad = memorySource({ "config/app.yaml": "id: [unclosed\n" }, root)
    expect(() => kit.load(root, { source: bad })).toThrow(/could not be parsed as YAML/)
    const missing = memorySource({}, root)
    expect(() => kit.load(root, { source: missing })).toThrow(AppConfigError)
  })

  it("exposes the matched raw entry on ResolvedItem.entry (null for file-only items)", () => {
    const root2 = mkdtempSync(join(tmpdir(), "app-config-source-test-"))
    try {
      mkdirSync(join(root2, "config/items"), { recursive: true })
      writeFileSync(join(root2, "config/app.yaml"), "id: doc-app\nitems:\n  - id: guide\n  - id: faq\n")
      writeFileSync(join(root2, "config/items/guide.yaml"), GUIDE_YAML)
      writeFileSync(join(root2, "config/items/extra.yaml"), "id: extra\ntitle: Extra\n")
      const resolved = kit.load(root2)
      // the matched raw entry, without the consumer recovering it via app.items[entryIndex]
      expect(resolved.items.get("guide")?.entry).toEqual({ id: "guide" })
      expect(resolved.items.get("extra")?.entry).toBeNull()
      expect(resolved.items.get("extra")?.entryIndex).toBeNull()
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Gate/Scope context: list + probe through the same guarded port
// ---------------------------------------------------------------------------

describe("gate context list + probe (ScopedSource)", () => {
  function writeOutputs(dir: string): void {
    mkdirSync(join(dir, "output"), { recursive: true })
    writeFileSync(join(dir, "output/chapter.md"), "text\n")
    writeFileSync(join(dir, "output/summary.md"), "text\n")
  }

  const listAndProbe: GateRule = {
    id: "list-probe",
    level: "error",
    test: (ctx) => {
      const names = ctx.source.listDir("output")
      const chapter = ctx.source.probe("output/chapter.md")
      const outputDir = ctx.source.probe("output")
      const missing = ctx.source.probe("output/rendered.pdf")
      const findings = []
      if (names.sort().join(",") !== "chapter.md,summary.md") {
        findings.push({ message: `unexpected listing: ${names.join(",")}` })
      }
      if (chapter !== "file") findings.push({ message: `chapter probe: ${String(chapter)}` })
      if (outputDir !== "dir") findings.push({ message: `output probe: ${String(outputDir)}` })
      // missing is a first-class finding, NOT a throw
      if (missing !== null) findings.push({ message: `missing probe: ${String(missing)}` })
      return findings
    },
  }

  const escape: GateRule = {
    id: "escape",
    level: "error",
    test: (ctx) => {
      const messages: string[] = []
      for (const [label, run] of [
        ["list", () => ctx.source.listDir("../outside")],
        ["probe", () => ctx.source.probe("../outside")],
        ["read", () => ctx.source.readFile("../outside.yaml")],
      ] as const) {
        try {
          run()
          messages.push(`${label}: no throw`)
        } catch (err) {
          messages.push(`${label}: ${err instanceof AppConfigError ? "AppConfigError" : "other"}`)
        }
      }
      return messages.map((message) => ({ message }))
    },
  }

  it("a gate rule LISTS a directory and PROBES file / dir / missing through the context without throwing", async () => {
    writeDiskFixture(root)
    writeOutputs(root)
    const resolved = kit.load(root)
    const result = await kit.gates(resolved, [listAndProbe])
    expect(result).toEqual({ ok: true, findings: [] })
  })

  it("a `..` traversal throws AppConfigError on list, probe and read", async () => {
    writeDiskFixture(root)
    writeOutputs(root)
    const resolved = kit.load(root)
    const result = await kit.gates(resolved, [escape])
    expect(result.findings.map((f) => f.message)).toEqual([
      "list: AppConfigError",
      "probe: AppConfigError",
      "read: AppConfigError",
    ])
  })

  it("gates over a MEMORY-resolved app read from the same memory source", async () => {
    const memKit = defineAppConfig({
      app: AppSchema,
      item: ItemSchema,
      itemsKey: "items",
      defaultsKey: "defaults",
      source: memorySource(
        {
          "config/app.yaml": APP_YAML,
          "config/items/guide.yaml": GUIDE_YAML,
          "config/items/faq.yaml": FAQ_YAML,
          "output/chapter.md": "text\n",
          "output/index.md": "text\n",
          "output/summary.md": "text\n",
        },
        root,
      ),
    })
    const resolved = memKit.load(root)
    const listing: GateRule = {
      id: "mem-list",
      level: "error",
      test: (ctx) => {
        const names = ctx.source.listDir("output").sort()
        if (names.join(",") !== "chapter.md,index.md,summary.md") {
          return [{ message: `unexpected listing: ${names.join(",")}` }]
        }
        if (ctx.source.probe("output/index.md") !== "file") return [{ message: "probe failed" }]
        return []
      },
    }
    const result = await memKit.gates(resolved, [listing])
    expect(result).toEqual({ ok: true, findings: [] })
  })

  it("scope contexts get the same guarded port", async () => {
    writeDiskFixture(root)
    writeOutputs(root)
    const resolved = kit.load(root)
    const report = await kit.verify(resolved, {
      scopes: {
        outputs: async (_r, ctx) => {
          const names = ctx.source.listDir("output")
          const probe = ctx.source.probe("output/chapter.md")
          if (names.length === 2 && probe === "file") return []
          return [{ scope: "outputs", level: "error", message: "listing/probe mismatch" }]
        },
      },
    })
    expect(report.findings.filter((f) => f.scope === "outputs")).toEqual([])
    expect(report.ok).toBe(true)
  })
})

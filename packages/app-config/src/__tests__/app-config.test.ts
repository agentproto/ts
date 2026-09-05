import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  AppConfigError,
  canonicalJson,
  defineAppConfig,
  isPlainObject,
  pick,
  sha256Hex,
  type GateRule,
} from "../index.js"

/** Extract `required` from a JSON Schema object without a single `as`. */
function requiredOf(schema: unknown): string[] {
  if (!isPlainObject(schema)) return []
  const r = pick(schema, "required")
  return Array.isArray(r.value) ? r.value.filter((x): x is string => typeof x === "string") : []
}

// ---------------------------------------------------------------------------
// Fixture app: a document-rendering app with two items (two docs).
// ---------------------------------------------------------------------------

const AppSchema = z.object({
  id: z.string(),
  defaults: z
    .object({
      lang: z.string().default("en"),
      render: z
        .object({
          format: z.string().default("pdf"),
          toc: z.boolean().default(true),
        })
        .default({ format: "pdf", toc: true }),
      assets: z.array(z.string()).default([]),
    })
    .default({ lang: "en", render: { format: "pdf", toc: true }, assets: [] }),
  items: z
    .array(
      z.object({
        id: z.string(),
        order: z.number().int().optional(),
      }),
    )
    .default([]),
})

const ItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  lang: z.string().default("en"),
  render: z
    .object({
      format: z.string().default("pdf"),
      toc: z.boolean().default(true),
    })
    .default({ format: "pdf", toc: true }),
  assets: z.array(z.string()).default([]),
})

const kit = defineAppConfig({
  app: AppSchema,
  item: ItemSchema,
  itemsKey: "items",
  defaultsKey: "defaults",
})

function writeApp(
  dir: string,
  opts: {
    app?: string
    items?: Record<string, string>
    appFile?: string
    itemsGlob?: string
  } = {},
): string {
  const appFile = opts.appFile ?? "config/app.yaml"
  const itemsGlob = opts.itemsGlob ?? "config/items/*.yaml"
  const appPath = join(dir, appFile)
  mkdirSync(join(appPath, ".."), { recursive: true })
  writeFileSync(appPath, opts.app ?? "")
  const itemsDir = join(dir, itemsGlob.includes("/") ? itemsGlob.slice(0, itemsGlob.lastIndexOf("/")) : "")
  mkdirSync(itemsDir, { recursive: true })
  for (const [name, text] of Object.entries(opts.items ?? {})) {
    writeFileSync(join(itemsDir, name), text)
  }
  return dir
}

const APP_YAML = `id: doc-app
defaults:
  lang: en
  render:
    format: pdf
    toc: true
  assets:
    - shared/logo.png
items:
  - id: guide
  - id: faq
`

const GUIDE_YAML = `id: guide
title: The Guide
render:
  format: epub
  toc: false
assets:
  - shared/logo.png
  - guide/diagram.png
`

const FAQ_YAML = `id: faq
title: the FAQ
`

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "app-config-test-"))
  writeApp(root, {
    app: APP_YAML,
    items: { "guide.yaml": GUIDE_YAML, "faq.yaml": FAQ_YAML },
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// load + precedence
// ---------------------------------------------------------------------------

describe("load", () => {
  it("resolves both items with entry order first, then file-only items", () => {
    const resolved = kit.load(root)
    expect(resolved.app.id).toBe("doc-app")
    expect(resolved.order).toEqual(["guide", "faq"])
    expect([...resolved.items.keys()].sort()).toEqual(["faq", "guide"])
  })

  it("applies precedence: app defaults → items[] entry → item file", () => {
    const resolved = kit.load(root)
    const guide = resolved.items.get("guide")
    expect(guide).toBeDefined()
    // item file wins over defaults (format: epub vs pdf, toc: false vs true)
    expect(guide?.value.render).toEqual({ format: "epub", toc: false })
    // entry carries no render overrides → defaults fill in lang
    expect(guide?.value.lang).toBe("en")
    expect(guide?.entryIndex).toBe(0)
    const faq = resolved.items.get("faq")
    // no item-file override → pure defaults
    expect(faq?.value.render).toEqual({ format: "pdf", toc: true })
    expect(faq?.value.assets).toEqual(["shared/logo.png"])
  })

  it("deep-merges objects and REPLACES arrays", () => {
    const resolved = kit.load(root)
    const guide = resolved.items.get("guide")
    // object: nested render merged key-by-key from defaults
    expect(guide?.value.render.format).toBe("epub")
    expect(guide?.value.render.toc).toBe(false)
    // array: item file's list REPLACES the defaults list wholesale
    expect(guide?.value.assets).toEqual(["shared/logo.png", "guide/diagram.png"])
  })

  it("carries entryIndex null for file-only items and orders them by filename", () => {
    const root2 = mkdtempSync(join(tmpdir(), "app-config-test-"))
    try {
      writeApp(root2, {
        app: "id: doc-app\nitems:\n  - id: b-item\n",
        items: {
          "z-item.yaml": "id: z-item\ntitle: Z\n",
          "a-item.yaml": "id: a-item\ntitle: A\n",
        },
      })
      const resolved = kit.load(root2)
      expect(resolved.order).toEqual(["a-item", "z-item"])
      expect(resolved.items.get("a-item")?.entryIndex).toBeNull()
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  it("honors a custom precedence permutation (item before entry)", () => {
    const entryWinsKit = defineAppConfig({
      app: AppSchema,
      item: ItemSchema,
      itemsKey: "items",
      defaultsKey: "defaults",
      precedence: ["defaults", "item", "entry"],
    })
    const root3 = mkdtempSync(join(tmpdir(), "app-config-test-"))
    try {
      writeApp(root3, {
        app: `id: doc-app
defaults:
  render:
    format: pdf
    toc: true
items:
  - id: guide
    render:
      format: docx
`,
        items: { "guide.yaml": "id: guide\ntitle: The Guide\nrender:\n  format: epub\n" },
      })
      const resolved = entryWinsKit.load(root3)
      // entry layer is highest → docx wins over the item file's epub
      expect(resolved.items.get("guide")?.value.render.format).toBe("docx")
    } finally {
      rmSync(root3, { recursive: true, force: true })
    }
  })

  it("rejects a bad precedence permutation and duplicate item ids", () => {
    expect(() =>
      defineAppConfig({ app: AppSchema, item: ItemSchema, itemsKey: "items", precedence: ["defaults", "defaults", "item"] }),
    ).toThrow(AppConfigError)
    const root4 = mkdtempSync(join(tmpdir(), "app-config-test-"))
    try {
      writeApp(root4, {
        app: "id: d\nitems: []\n",
        items: { "a.yaml": "id: dup\ntitle: A\n", "b.yaml": "id: dup\ntitle: B\n" },
      })
      expect(() => kit.load(root4)).toThrow(/duplicate item ids/)
    } finally {
      rmSync(root4, { recursive: true, force: true })
    }
  })

  it("validates against the item schema (zod failure surfaces)", () => {
    const root5 = mkdtempSync(join(tmpdir(), "app-config-test-"))
    try {
      writeApp(root5, { app: "id: d\nitems: []\n", items: { "x.yaml": "id: x\n" } })
      expect(() => kit.load(root5)).toThrow()
    } finally {
      rmSync(root5, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// JSON Schemas
// ---------------------------------------------------------------------------

describe("jsonSchemas", () => {
  it("emits input-io schemas where defaulted fields are NOT required", () => {
    const { app, item } = kit.jsonSchemas()
    expect(requiredOf(app)).not.toContain("defaults")
    expect(requiredOf(app)).not.toContain("items")
    expect(requiredOf(item)).toEqual(["id", "title"])
    expect(requiredOf(item)).not.toContain("lang")
    expect(requiredOf(item)).not.toContain("render")
    expect(requiredOf(item)).not.toContain("assets")
  })

  it("writeSchemas writes both files", () => {
    kit.writeSchemas(join(root, "schemas"))
    const written: unknown = JSON.parse(readFileSync(join(root, "schemas", "item.schema.json"), "utf8"))
    expect(requiredOf(written)).toEqual(["id", "title"])
    expect(readFileSync(join(root, "schemas", "app.schema.json"), "utf8")).toContain("$schema")
  })
})

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

describe("contracts", () => {
  const template = (item: { id: string; value: { title: string; lang: string; render: { format: string } } }) => ({
    schema: "item-contract/v1",
    id: item.id,
    title: item.value.title,
    lang: item.value.lang,
    format: item.value.render.format,
  })

  it("writes deterministic files (sorted keys), then check() reports no drift", () => {
    const resolved = kit.load(root)
    const dir = join(root, "contracts")
    kit.contracts({ resolved, template, dir }).write()

    const text = readFileSync(join(dir, "guide.contract.json"), "utf8")
    const parsed: unknown = JSON.parse(text)
    // stable key order: re-serializing the canonical form reproduces the file byte-for-byte
    expect(JSON.stringify(JSON.parse(canonicalJson(parsed)), null, 2) + "\n").toBe(text)
    expect(text.indexOf('"format"')).toBeLessThan(text.indexOf('"id"'))
    expect(text.indexOf('"id"')).toBeLessThan(text.indexOf('"lang"'))

    expect(kit.contracts({ resolved, template, dir }).check()).toEqual([])
  })

  it("check() detects drift after the config changes and reports missing files", () => {
    const resolved = kit.load(root)
    const dir = join(root, "contracts")
    const handle = kit.contracts({ resolved, template, dir })
    handle.write()
    expect(handle.check()).toEqual([])

    // config drift: the item file's format changed under a frozen contract
    writeFileSync(join(root, "config/items/guide.yaml"), GUIDE_YAML.replace("format: epub", "format: web"))
    const reloaded = kit.load(root)
    const drift = kit.contracts({ resolved: reloaded, template, dir }).check()
    expect(drift).toEqual([
      { id: "guide", file: join(dir, "guide.contract.json"), reason: "drifted" },
    ])

    // missing file
    rmSync(join(dir, "faq.contract.json"))
    const drift2 = kit.contracts({ resolved: reloaded, template, dir }).check()
    expect(drift2.map((d) => d.id)).toEqual(["guide", "faq"])
    expect(drift2.map((d) => d.reason)).toEqual(["drifted", "missing"])
  })

  it("hashes the canonical JSON (key order in the template output is irrelevant)", () => {
    const a = { b: 1, a: [2, { y: 1, x: 2 }] }
    const b = { a: [2, { x: 2, y: 1 }], b: 1 }
    expect(sha256Hex(canonicalJson(a))).toBe(sha256Hex(canonicalJson(b)))
  })
})

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe("gates", () => {
  const everyTitleUppercase: GateRule = {
    id: "title-case",
    level: "error",
    test: (resolved) =>
      resolved.order
        .filter((id) => {
          const item = resolved.items.get(id)
          return item !== undefined && !/^[A-Z]/.test(String(item.value.title))
        })
        .map((id) => ({ message: `item ${id}: title must start uppercase`, item: id })),
  }

  it("runs rules and fails on error-level findings", () => {
    const resolved = kit.load(root)
    const result = kit.gates(resolved, [everyTitleUppercase])
    expect(result.ok).toBe(false)
    expect(result.findings).toEqual([
      { rule: "title-case", level: "error", message: "item faq: title must start uppercase", item: "faq" },
    ])
  })

  it("warn-level findings do not flip ok", () => {
    const resolved = kit.load(root)
    const result = kit.gates(resolved, [{ ...everyTitleUppercase, level: "warn" }])
    expect(result.ok).toBe(true)
    expect(result.findings).toHaveLength(1)
  })

  it("passes when no findings", () => {
    const resolved = kit.load(root)
    const result = kit.gates(resolved, [
      { id: "always", level: "error", test: () => [] },
    ])
    expect(result).toEqual({ ok: true, findings: [] })
  })
})

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

describe("verify", () => {
  it("composes gates + contracts.check + caller scopes into one report", () => {
    const resolved = kit.load(root)
    const dir = join(root, "contracts")
    kit.contracts({
      resolved,
      template: (item) => ({ id: item.id, title: item.value.title }),
      dir,
    }).write()

    const report = kit.verify(resolved, {
      rules: [
        { id: "noop", level: "error", test: () => [] },
        {
          id: "warn-epub",
          level: "warn",
        test: (r) =>
          r.order
            .filter((id) => {
              const render = r.items.get(id)?.value.render
              return isPlainObject(render) && render["format"] === "epub"
            })
            .map((id) => ({ message: "epub render is experimental", item: id })),
        },
      ],
      template: (item) => ({ id: item.id, title: item.value.title }),
      contractsDir: dir,
      scopes: {
        assets: () => [{ scope: "assets", level: "skipped", message: "no assets index yet" }],
        ledger: () => [{ scope: "ledger", level: "error", message: "ledger line 3: bad envelope", item: "faq" }],
      },
    })

    expect(report.ok).toBe(false)
    expect(report.summary).toEqual({ errors: 1, warnings: 1, skipped: 1 })
    expect(report.findings.map((f) => `${f.scope}/${f.level}`)).toEqual([
      "gates/warn",
      "assets/skipped",
      "ledger/error",
    ])
  })

  it("reports contract drift through the contracts scope", () => {
    const resolved = kit.load(root)
    const report = kit.verify(resolved, {
      template: (item) => ({ id: item.id }),
      contractsDir: join(root, "contracts"),
    })
    expect(report.ok).toBe(false)
    const contractFindings = report.findings.filter((f) => f.scope === "contracts")
    expect(contractFindings).toHaveLength(2)
    expect(contractFindings.every((f) => f.level === "error" && /missing on disk/.test(f.message))).toBe(true)
  })

  it("is ok when everything passes", () => {
    const resolved = kit.load(root)
    const report = kit.verify(resolved, {
      rules: [{ id: "noop", level: "error", test: () => [] }],
      scopes: { extra: () => [] },
    })
    expect(report).toEqual({ ok: true, findings: [], summary: { errors: 0, warnings: 0, skipped: 0 } })
  })
})

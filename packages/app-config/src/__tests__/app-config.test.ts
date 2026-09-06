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
  resolveItemFileInfos,
  sha256Hex,
  type GateRule,
  type VerifyFinding,
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
      expect(() => kit.load(root4)).toThrow(/duplicate item keys/)
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
    test: (ctx) =>
      ctx.resolved.order
        .filter((id) => {
          const item = ctx.resolved.items.get(id)
          return item !== undefined && !/^[A-Z]/.test(String(item.value.title))
        })
        .map((id) => ({ message: `item ${id}: title must start uppercase`, item: id })),
  }

  it("runs rules and fails on error-level findings", async () => {
    const resolved = kit.load(root)
    const result = await kit.gates(resolved, [everyTitleUppercase])
    expect(result.ok).toBe(false)
    expect(result.findings).toEqual([
      { rule: "title-case", level: "error", message: "item faq: title must start uppercase", item: "faq" },
    ])
  })

  it("warn-level findings do not flip ok", async () => {
    const resolved = kit.load(root)
    const result = await kit.gates(resolved, [{ ...everyTitleUppercase, level: "warn" }])
    expect(result.ok).toBe(true)
    expect(result.findings).toHaveLength(1)
  })

  it("passes when no findings", async () => {
    const resolved = kit.load(root)
    const result = await kit.gates(resolved, [
      { id: "always", level: "error", test: () => [] },
    ])
    expect(result).toEqual({ ok: true, findings: [] })
  })
})

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

describe("verify", () => {
  it("composes gates + contracts.check + caller scopes into one report", async () => {
    const resolved = kit.load(root)
    const dir = join(root, "contracts")
    kit.contracts({
      resolved,
      template: (item) => ({ id: item.id, title: item.value.title }),
      dir,
    }).write()

    const report = await kit.verify(resolved, {
      rules: [
        { id: "noop", level: "error", test: () => [] },
        {
          id: "warn-epub",
          level: "warn",
        test: (ctx) =>
          ctx.resolved.order
            .filter((id) => {
              const render = ctx.resolved.items.get(id)?.value.render
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

  it("reports contract drift through the contracts scope", async () => {
    const resolved = kit.load(root)
    const report = await kit.verify(resolved, {
      template: (item) => ({ id: item.id }),
      contractsDir: join(root, "contracts"),
    })
    expect(report.ok).toBe(false)
    const contractFindings = report.findings.filter((f) => f.scope === "contracts")
    expect(contractFindings).toHaveLength(2)
    expect(contractFindings.every((f) => f.level === "error" && /missing on disk/.test(f.message))).toBe(true)
  })

  it("is ok when everything passes", async () => {
    const resolved = kit.load(root)
    const report = await kit.verify(resolved, {
      rules: [{ id: "noop", level: "error", test: () => [] }],
      scopes: { extra: () => [] },
    })
    expect(report).toEqual({ ok: true, findings: [], summary: { errors: 0, warnings: 0, skipped: 0 } })
  })
})

// ---------------------------------------------------------------------------
// v0.2: matchKey / nested defaultsKey / mergeArraysBy / project / item discovery
// ---------------------------------------------------------------------------

describe("book-shaped data model (no id, matched by n)", () => {
  const CollectionSchema = z.object({
    id: z.string(),
    presets: z
      .object({
        default: z.object({ lang: z.string().default("en"), bibMax: z.number().default(40) }),
      })
      .default({ default: { lang: "en", bibMax: 40 } }),
    cover: z.object({ accents: z.record(z.string(), z.string()) }).default({ accents: {} }),
    order: z
      .array(z.object({ n: z.number().int(), slug: z.string(), tier: z.string() }))
      .default([]),
  })

  const BookSchema = z.object({
    n: z.number().int(),
    slug: z.string(),
    vertical: z.string(),
    accent: z.string().optional(),
    lang: z.string().default("en"),
    bibMax: z.number().default(40),
  })

  const bookKit = defineAppConfig({
    app: CollectionSchema,
    item: BookSchema,
    itemsKey: "order",
    defaultsKey: "presets.default",
    matchKey: { entry: "n", item: "n" },
    project: (merged, ctx) => {
      const accents = ctx.app.cover.accents
      const vertical = typeof merged["vertical"] === "string" ? merged["vertical"] : ""
      const fallback = accents[vertical]
      return {
        ...merged,
        accent:
          merged["accent"] !== undefined ? merged["accent"] : typeof fallback === "string" ? fallback : undefined,
      }
    },
  })

  function writeBooks(dir: string): string {
    mkdirSync(join(dir, "manuscripts/book-one"), { recursive: true })
    mkdirSync(join(dir, "manuscripts/book-two"), { recursive: true })
    writeFileSync(
      join(dir, "collection.yaml"),
      `id: augmented
presets:
  default:
    lang: fr
    bibMax: 60
cover:
  accents:
    seo: "#0a7"
order:
  - { n: 1, slug: book-one, tier: pro }
  - { n: 2, slug: book-two, tier: mass }
`,
    )
    writeFileSync(join(dir, "manuscripts/book-one/book.yaml"), "n: 1\nslug: book-one\nvertical: seo\n")
    writeFileSync(join(dir, "manuscripts/book-two/book.yaml"), "n: 2\nslug: book-two\nvertical: none\naccent: '#f0f'\n")
    return dir
  }

  it("matches entries by the n field pair, keys items by their dir, exposes dir", () => {
    const root2 = writeBooks(mkdtempSync(join(tmpdir(), "app-config-test-")))
    try {
      const resolved = bookKit.load(root2, { appFile: "collection.yaml", itemsGlob: "manuscripts/*/book.yaml" })
      expect(resolved.order).toEqual(["book-one", "book-two"])
      const one = resolved.items.get("book-one")
      expect(one?.entryIndex).toBe(0)
      expect(one?.dir).toBe(join(root2, "manuscripts/book-one"))
      expect(one?.itemPath).toBe(join(root2, "manuscripts/book-one/book.yaml"))
      // nested defaultsKey path filled lang/bibMax in
      expect(one?.value.lang).toBe("fr")
      expect(one?.value.bibMax).toBe(60)
      // project(): accent falls back to the app-level accents[vertical] map
      expect(one?.value.accent).toBe("#0a7")
      // explicit accent wins over the projection fallback
      expect(resolved.items.get("book-two")?.value.accent).toBe("#f0f")
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  it("supports a predicate matchKey", () => {
    const predKit = defineAppConfig({
      app: CollectionSchema,
      item: BookSchema,
      itemsKey: "order",
      matchKey: (entry, item) => entry["slug"] === item["slug"],
    })
    const root2 = writeBooks(mkdtempSync(join(tmpdir(), "app-config-test-")))
    try {
      const resolved = predKit.load(root2, { appFile: "collection.yaml", itemsGlob: "manuscripts/*/book.yaml" })
      expect(resolved.items.get("book-one")?.entryIndex).toBe(0)
      expect(resolved.items.get("book-two")?.entryIndex).toBe(1)
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })
})

describe("mergeArraysBy (keyed-array merge)", () => {
  const AppSchema = z.object({
    id: z.string(),
    knowledge: z
      .object({
        defaults: z.array(z.object({ workspace: z.string(), tags: z.array(z.string()) })).default([]),
      })
      .default({ defaults: [] }),
    items: z.array(z.object({ id: z.string() })).default([]),
  })
  const ItemSchema = z.object({
    id: z.string(),
    knowledge: z.array(z.object({ workspace: z.string(), tags: z.array(z.string()) })).default([]),
  })
  const keyedKit = defineAppConfig({
    app: AppSchema,
    item: ItemSchema,
    itemsKey: "items",
    defaultsKey: "knowledge.defaults",
    mergeArraysBy: { knowledge: "workspace" },
  })

  it("replaces same-key entries and appends new ones instead of replacing wholesale", () => {
    const root2 = mkdtempSync(join(tmpdir(), "app-config-test-"))
    try {
      mkdirSync(join(root2, "config/items"), { recursive: true })
      writeFileSync(
        join(root2, "config/app.yaml"),
        `id: k
knowledge:
  defaults:
    - { workspace: series, tags: [a, b] }
    - { workspace: craft, tags: [c] }
items: []
`,
      )
      writeFileSync(
        join(root2, "config/items/book.yaml"),
        `id: book
knowledge:
  - { workspace: series, tags: [narrowed] }
  - { workspace: own, tags: [d] }
`,
      )
      const resolved = keyedKit.load(root2)
      const item = resolved.items.get("book")
      // same workspace → the item's selector REPLACES the series default in place
      // new workspace → appended after
      expect(item?.value.knowledge).toEqual([
        { workspace: "series", tags: ["narrowed"] },
        { workspace: "craft", tags: ["c"] },
        { workspace: "own", tags: ["d"] },
      ])
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })
})

describe("item discovery shapes", () => {
  it("resolveItemFileInfos resolves fixed basenames, wildcard dirs and recursion with keys", () => {
    const root2 = mkdtempSync(join(tmpdir(), "app-config-test-"))
    try {
      mkdirSync(join(root2, "manuscripts/b1"), { recursive: true })
      mkdirSync(join(root2, "manuscripts/b2"), { recursive: true })
      mkdirSync(join(root2, "manuscripts/b2/extra"), { recursive: true })
      writeFileSync(join(root2, "manuscripts/b1/book.yaml"), "n: 1\n")
      writeFileSync(join(root2, "manuscripts/b2/book.yaml"), "n: 2\n")
      writeFileSync(join(root2, "manuscripts/b2/extra/notes.yaml"), "x: 1\n")

      const fixed = resolveItemFileInfos(root2, "manuscripts/*/book.yaml")
      expect(fixed.map((f) => f.key)).toEqual(["b1", "b2"])
      expect(fixed.every((f) => f.path.endsWith("book.yaml"))).toBe(true)

      const flat = resolveItemFileInfos(root2, "manuscripts/b1/*.yaml")
      expect(flat.map((f) => f.key)).toEqual(["book"])

      const recursive = resolveItemFileInfos(root2, "manuscripts/**/notes.yaml")
      expect(recursive).toHaveLength(1)
      expect(recursive[0]?.path).toBe(join(root2, "manuscripts/b2/extra/notes.yaml"))
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// v0.3: async scopes with ScopeContext, per-finding gate levels, projected
// ---------------------------------------------------------------------------

describe("v0.3 scope context (async + readArtifact)", () => {
  it("an async scope reads artifacts through ctx and reports per-finding levels", async () => {
    const root2 = mkdtempSync(join(tmpdir(), "app-config-test-"))
    try {
      writeApp(root2, {
        app: "id: doc-app\nitems:\n  - id: guide\n",
        items: { "guide.yaml": "id: guide\ntitle: The Guide\n" },
      })
      mkdirSync(join(root2, "output"), { recursive: true })
      writeFileSync(join(root2, "output/summary.md"), "ok line\nthis line is far too long for the scope to accept\n")
      const resolved = kit.load(root2)

      const report = await kit.verify(resolved, {
        scopes: {
          lines: async (r, ctx) => {
            const text = await ctx.readArtifact("output/summary.md")
            const tooLongLines = text
              .split("\n")
              .map((line, i) => ({ line, n: i + 1 }))
              .filter(({ line }) => line.length > 40)
            const tooLong: VerifyFinding[] = tooLongLines.map(({ n }) => ({
              scope: "lines",
              level: "warn",
              message: `line ${n}: too long`,
              item: "guide",
            }))
            const findings: VerifyFinding[] = [
              ...tooLong,
              { scope: "lines", level: "skipped", message: "word count unavailable" },
            ]
            return findings
          },
        },
      })

      expect(report.findings.filter((f) => f.scope === "lines").map((f) => f.level)).toEqual([
        "warn",
        "skipped",
      ])
      expect(report.summary).toMatchObject({ errors: 0, warnings: 1, skipped: 1 })
      expect(report.ok).toBe(true)

      // ctx.readArtifact rejects root escapes, same guard as gate rules
      const escaped = await kit.verify(resolved, {
        scopes: {
          escape: async (_r, ctx) => {
            try {
              await ctx.readArtifact("../outside.yaml")
              return [{ scope: "escape", level: "error", message: "should not get here" }]
            } catch (err) {
              return [{ scope: "escape", level: "error", message: String(err) }]
            }
          },
        },
      })
      expect(escaped.findings[0]?.message).toContain("escapes rootDir")
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })
})

describe("v0.3 per-finding gate level", () => {
  it("a finding's own level overrides the rule's level", async () => {
    const resolved = kit.load(root)
    const result = await kit.gates(resolved, [
      {
        id: "degrade",
        level: "error",
        test: () => [
          { message: "serious", item: "guide" },
          { message: "minor", item: "faq", level: "warn" },
        ],
      },
    ])
    expect(result.findings).toEqual([
      { rule: "degrade", level: "error", message: "serious", item: "guide" },
      { rule: "degrade", level: "warn", message: "minor", item: "faq" },
    ])
    // ok flips only on the error-level finding
    expect(result.ok).toBe(false)
  })
})

describe("v0.3 projected output", () => {
  it("exposes the projected object (pre-parse) on ResolvedItem.projected", () => {
    const resolved = kit.load(root)
    // kit has no project hook → projected is absent
    expect(resolved.items.get("guide")?.projected).toBeUndefined()

    const derivedKit = defineAppConfig({
      app: AppSchema,
      item: ItemSchema,
      itemsKey: "items",
      defaultsKey: "defaults",
      project: (merged, ctx) => ({
        ...merged,
        derivedLang: `${String(merged["lang"])}-${ctx.app.id}`,
      }),
    })
    const r2 = derivedKit.load(root)
    const guide = r2.items.get("guide")
    // the item schema does not declare derivedLang → parse strips it from value
    expect(guide?.value).not.toHaveProperty("derivedLang")
    // but the projected object keeps it verbatim
    expect(guide?.projected).toMatchObject({ derivedLang: "en-doc-app" })
  })
})

describe("v0.3 non-zod SchemaLike", () => {
  it("accepts a hand-rolled { parse } and throws a CLEAR kit error from jsonSchemas", async () => {
    const handKit = defineAppConfig({
      app: {
        parse: (value: unknown) => {
          if (!isPlainObject(value)) throw new Error("app must be an object")
          const p = pick(value, "id")
          if (typeof p.value !== "string") throw new Error("app must have a string id")
          return { ...value, id: p.value }
        },
      },
      item: ItemSchema,
      itemsKey: "items",
    })
    // load works: only parse() is needed
    const resolved = handKit.load(root)
    expect(resolved.order).toEqual(["guide", "faq"])
    // JSON Schema conversion cannot introspect a non-zod schema → clear error
    expect(() => handKit.jsonSchemas()).toThrow(/not a zod schema/)
  })
})

// ---------------------------------------------------------------------------
// v0.2: gate ctx (readArtifact) + attrs
// ---------------------------------------------------------------------------

describe("gates with artifacts and attrs", () => {
  it("a rule reads a fixture artifact and reports attrs through verify", async () => {
    const root2 = mkdtempSync(join(tmpdir(), "app-config-test-"))
    try {
      writeApp(root2, {
        app: "id: doc-app\nitems:\n  - id: guide\n",
        items: { "guide.yaml": "id: guide\ntitle: The Guide\n" },
      })
      mkdirSync(join(root2, "output"), { recursive: true })
      writeFileSync(join(root2, "output/chapter.md"), "short line\nthis line is far too long for the gate to accept\n")
      const resolved = kit.load(root2)

      const lineWidth: GateRule = {
        id: "line-width",
        level: "error",
        test: async (ctx) => {
          const text = await ctx.readArtifact("output/chapter.md")
          return text
            .split("\n")
            .map((line, i) => ({ line, n: i + 1 }))
            .filter(({ line }) => line.length > 40)
            .map(({ line, n }) => ({
              message: `line ${n}: ${line.length} chars exceeds 40`,
              item: "guide",
              attrs: { chapter: "ch1" },
            }))
        },
      }

      const result = await kit.gates(resolved, [lineWidth])
      expect(result.ok).toBe(false)
      expect(result.findings).toEqual([
        {
          rule: "line-width",
          level: "error",
          message: "line 2: 48 chars exceeds 40",
          item: "guide",
          attrs: { chapter: "ch1" },
        },
      ])

      // readArtifact rejects paths escaping the root
      const escape: GateRule = {
        id: "escape",
        level: "error",
        test: (ctx) => ctx.readArtifact("../outside.yaml").then(() => [], (err: unknown) => [{ message: String(err) }]),
      }
      const escResult = await kit.gates(resolved, [escape])
      expect(escResult.findings[0]?.message).toContain("escapes rootDir")

      // attrs propagate into the composed verify report
      const report = await kit.verify(resolved, {
        rules: [lineWidth],
        scopes: {
          ledger: () => [{ scope: "ledger", level: "error", message: "bad", item: "guide", attrs: { book: "b1", chapter: "c1" } }],
        },
      })
      const gateFinding = report.findings.find((f) => f.scope === "gates")
      expect(gateFinding?.attrs).toEqual({ chapter: "ch1" })
      const scopeFinding = report.findings.find((f) => f.scope === "ledger")
      expect(scopeFinding?.attrs).toEqual({ book: "b1", chapter: "c1" })
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })
})

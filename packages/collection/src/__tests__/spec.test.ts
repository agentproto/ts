import { describe, it, expect } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { collectionSpec, collectionVerbs } from "../spec.js"
import { parseCollectionManifest, collectionFromManifest } from "../manifest/index.js"
import type { CollectionVerbParams } from "../spec.js"

const HERE = dirname(fileURLToPath(import.meta.url))

const METRIC_SAMPLE_SCHEMA: CollectionVerbParams = {
  schema: "collection.schema/v1",
  name: "metric-sample",
  title: "Metric sample",
  description: "One dated observation of one metric, read from one declared source.",
  version: "1.0.0",
  fields: [
    { name: "metric", type: "string", required: true },
    { name: "value", type: "number", required: true },
    {
      name: "unit",
      type: "enum",
      enum: ["eur", "usd", "count", "percent", "credits", "ms", "boolean"],
      required: true,
    },
    {
      name: "periodKind",
      type: "enum",
      enum: ["point", "day", "week", "month", "total"],
      required: true,
    },
    { name: "periodStart", type: "datetime", required: true },
    { name: "periodEnd", type: "datetime", required: true },
    { name: "observedAt", type: "datetime", required: true },
    { name: "source", type: "string", required: true },
    { name: "idempotencyKey", type: "string", required: true },
    { name: "runId", type: "string", required: false },
    { name: "proof", type: "string", required: false },
  ],
  identity: {
    slugSource: "idempotencyKey",
  },
}

describe("collectionVerbs", () => {
  it("round-trips a collection.schema/v1 manifest without loss", async () => {
    const dir = await mkdtemp(join(HERE, ".tmp-collection-verbs-"))
    try {
      const created = await collectionVerbs.create(METRIC_SAMPLE_SCHEMA, {
        dir,
        body: "Metric sample collection.\n",
      })
      expect(created.path).toBe(join(dir, "collections", "metric-sample", "COLLECTION.md"))

      const parsed = parseCollectionManifest(created.rendered)
      const fromManifest = collectionFromManifest(parsed)
      expect(fromManifest).toMatchObject({
        schema: "collection.schema/v1",
        name: "metric-sample",
        title: "Metric sample",
        version: "1.0.0",
        identity: { slugSource: "idempotencyKey" },
      })
      expect(fromManifest.schema === "collection.schema/v1" && fromManifest.fields?.length).toBe(11)

      const loaded = await collectionVerbs.load(created.path)
      expect(loaded.handle).toEqual(fromManifest)
      expect(loaded.body.trim()).toBe("Metric sample collection.")

      const listed = await collectionVerbs.list(dir)
      expect(listed).toHaveLength(1)
      expect(listed[0]).toEqual(fromManifest)

      const updated = await collectionVerbs.update(created.path, (p) => ({
        ...p,
        version: "1.1.0",
      }))
      expect(updated.handle.schema === "collection.schema/v1" && updated.handle.version).toBe("1.1.0")

      const reRendered = await collectionVerbs.create(updated.handle as CollectionVerbParams, {
        dir,
        body: loaded.body,
        dryRun: true,
      })
      expect(reRendered.rendered).toBe(updated.rendered)

      await collectionVerbs.delete(created.path)
      expect(await collectionVerbs.list(dir)).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("preserves collection.item/v1 schema in toFrontmatter and pathOf", async () => {
    const item: CollectionVerbParams = {
      schema: "collection.item/v1",
      collection: "metric-sample",
      id: "ab".repeat(32),
      title: "Gross volume 2026-11-25",
    }
    const fm = collectionSpec.toFrontmatter!(item)
    expect(fm.schema).toBe("collection.item/v1")

    const dry = await collectionVerbs.create(item, { dir: ".", dryRun: true })
    expect(dry.path).toBe(`items/${"ab".repeat(32)}/ITEM.md`)
    const parsed = parseCollectionManifest(dry.rendered)
    expect(parsed.frontmatter.schema).toBe("collection.item/v1")
  })
})

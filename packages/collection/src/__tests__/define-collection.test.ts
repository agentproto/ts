import { describe, it, expect } from "vitest"
import { defineCollection } from "../define-collection.js"
import type { CollectionDefinition } from "../types.js"

const MINIMAL_SCHEMA: CollectionDefinition = {
  schema: "collection.schema/v1",
  name: "tasks",
  title: "Tasks",
  description: "A minimal task collection.",
  version: "1.0.0",
}

const MINIMAL_ITEM: CollectionDefinition = {
  schema: "collection.item/v1",
  collection: "tasks",
  id: "TASK-1",
  title: "Ship the release notes",
}

describe("defineCollection (AIP-18)", () => {
  it("constructs a frozen handle from a minimal collection.schema/v1 def", () => {
    const handle = defineCollection(MINIMAL_SCHEMA)
    expect(handle).toMatchObject({ schema: "collection.schema/v1", name: "tasks" })
    expect(Object.isFrozen(handle)).toBe(true)
  })

  it("constructs a frozen handle from a minimal collection.item/v1 def", () => {
    const handle = defineCollection(MINIMAL_ITEM)
    expect(handle).toMatchObject({ schema: "collection.item/v1", id: "TASK-1" })
    expect(Object.isFrozen(handle)).toBe(true)
  })

  it("accepts a collection.item/v1 def with the object-form collection ref (version pin)", () => {
    const handle = defineCollection({
      ...MINIMAL_ITEM,
      collection: { name: "tasks", version: "1.x" },
    } as CollectionDefinition)
    expect(handle.collection).toEqual({ name: "tasks", version: "1.x" })
  })

  it("accepts arbitrary collection-specific fields on an item (additionalProperties: true)", () => {
    const handle = defineCollection({
      ...MINIMAL_ITEM,
      severity: "high",
      customVendorField: 42,
    } as unknown as CollectionDefinition)
    expect((handle as unknown as Record<string, unknown>).severity).toBe("high")
  })

  it("rejects a schema doc missing required fields (title)", () => {
    const { title: _title, ...withoutTitle } = MINIMAL_SCHEMA
    expect(() => defineCollection(withoutTitle as CollectionDefinition)).toThrow(
      /defineCollection \(AIP-18\)/,
    )
  })

  it("rejects an unrecognized `schema` discriminator value", () => {
    expect(() =>
      defineCollection({
        ...MINIMAL_SCHEMA,
        schema: "collection.bogus/v1",
      } as unknown as CollectionDefinition),
    ).toThrow(/defineCollection \(AIP-18\)/)
  })

  it("rejects an unknown top-level property on a schema doc (additionalProperties: false)", () => {
    expect(() =>
      defineCollection({
        ...MINIMAL_SCHEMA,
        notARealField: true,
      } as unknown as CollectionDefinition),
    ).toThrow(/defineCollection \(AIP-18\)/)
  })

  it("rejects an invalid `name` (uppercase not allowed)", () => {
    expect(() =>
      defineCollection({ ...MINIMAL_SCHEMA, name: "Tasks" } as CollectionDefinition),
    ).toThrow(/defineCollection \(AIP-18\)/)
  })

  describe("field companion keys (if/then on $defs/fieldDef and $defs/fieldShape)", () => {
    const withFields = (fields: unknown[]) =>
      ({ ...MINIMAL_SCHEMA, fields }) as unknown as CollectionDefinition

    it("rejects type=enum without enum", () => {
      expect(() =>
        defineCollection(withFields([{ name: "priority", type: "enum" }])),
      ).toThrow(/fields\.0\.enum: enum is required when type=enum/)
    })

    it("accepts type=enum with enum", () => {
      expect(() =>
        defineCollection(withFields([{ name: "priority", type: "enum", enum: ["low", "high"] }])),
      ).not.toThrow()
    })

    it("rejects type=array without items", () => {
      expect(() =>
        defineCollection(withFields([{ name: "tags", type: "array" }])),
      ).toThrow(/fields\.0\.items: items is required when type=array/)
    })

    it("rejects type=ref without refKind", () => {
      expect(() =>
        defineCollection(withFields([{ name: "reviewer", type: "ref" }])),
      ).toThrow(/fields\.0\.refKind: refKind is required when type=ref/)
    })

    it("accepts type=ref with refKind", () => {
      expect(() =>
        defineCollection(withFields([{ name: "reviewer", type: "ref", refKind: "engineer" }])),
      ).not.toThrow()
    })

    it("enforces the companion keys inside nested items (enum in items)", () => {
      expect(() =>
        defineCollection(withFields([{ name: "sev", type: "array", items: { type: "enum" } }])),
      ).toThrow(/fields\.0\.items\.enum: enum is required when type=enum/)
    })

    it("enforces the companion keys inside nested items (array of array)", () => {
      expect(() =>
        defineCollection(withFields([{ name: "m", type: "array", items: { type: "array" } }])),
      ).toThrow(/fields\.0\.items\.items: items is required when type=array/)
    })

    it("accepts a name-less nested array (array of array of string)", () => {
      expect(() =>
        defineCollection(
          withFields([
            { name: "m", type: "array", items: { type: "array", items: { type: "string" } } },
          ]),
        ),
      ).not.toThrow()
    })

    it("rejects a `name` inside items (name is only valid on fields[] entries)", () => {
      expect(() =>
        defineCollection(
          withFields([{ name: "tags", type: "array", items: { name: "tag", type: "string" } }]),
        ),
      ).toThrow(/defineCollection \(AIP-18\)/)
    })

    it("still requires `name` on fields[] entries", () => {
      expect(() => defineCollection(withFields([{ type: "string" }]))).toThrow(
        /defineCollection \(AIP-18\)/,
      )
    })
  })

  it("rejects a recursive array field whose inner `items` violates fieldDef's own shape", () => {
    expect(() =>
      defineCollection({
        ...MINIMAL_SCHEMA,
        fields: [
          {
            name: "matrix",
            type: "array",
            items: { name: "row", type: "array", items: { name: "cell" } },
          },
        ],
      } as unknown as CollectionDefinition),
    ).toThrow(/defineCollection \(AIP-18\)/)
  })
})

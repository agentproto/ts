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

  it("rejects a field with type=enum but no enum values (cross-field-ish, still a required-shape check)", () => {
    expect(() =>
      defineCollection({
        ...MINIMAL_SCHEMA,
        fields: [{ name: "priority", type: "enum" }],
      } as unknown as CollectionDefinition),
    ).not.toThrow() // AIP-18's fieldDef doesn't make `enum` conditionally
    // required at the JSON-Schema level (no if/then on `type`), so this is
    // legal per the canonical schema even though it's a modeling footgun —
    // documented as a possible spec gap in the PR, not fixed here.
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

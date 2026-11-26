/**
 * AIP-18 doctype spec — fed to `@agentproto/manifest.createVerbs`
 * to derive create / load / list / update / resolve / delete in one
 * place. Supports both branches of the AIP-18 discriminated union:
 *   - `collection.schema/v1` -> `collections/<name>/COLLECTION.md`
 *   - `collection.item/v1`   -> `items/<id>/ITEM.md`
 */

import { filterSerializable } from "@agentproto/doctype"
import { createVerbs, type DoctypeSpec } from "@agentproto/manifest"
import { defineCollection } from "./define-collection.js"
import { parseCollectionManifest } from "./manifest/index.js"
import type { CollectionDefinition, CollectionHandle } from "./types.js"

export type CollectionVerbParams = CollectionDefinition & {
  id?: string
  slug?: string
  name?: string
}

export const collectionSpec: DoctypeSpec<CollectionVerbParams, CollectionHandle> = {
  name: "collection",
  aip: 18,
  schemaLiteral: "collection.schema/v1",
  pathOf: (h) =>
    h.schema === "collection.item/v1"
      ? `items/${h.id}/ITEM.md`
      : `collections/${h.name}/COLLECTION.md`,
  define: (params) => defineCollection(params),
  parse: (source) => {
    const m = parseCollectionManifest(source)
    return {
      frontmatter: m.frontmatter as unknown as Record<string, unknown>,
      body: m.body,
    }
  },
  toFrontmatter: (params) => {
    const schema = params.schema ?? "collection.schema/v1"
    return filterSerializable({
      ...params,
      schema,
    }) as Record<string, unknown>
  },
}

export const collectionVerbs = createVerbs(collectionSpec)

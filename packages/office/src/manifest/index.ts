/**
 * AIP-22 OFFICE.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineOffice` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-22/draft/OFFICE.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import matter from "gray-matter"
import { officeFrontmatterSchema, type OfficeFrontmatter } from "../schema.js"
import { defineOffice } from "../define-office.js"
import type { OfficeDefinition, OfficeHandle } from "../types.js"
import type { OfficeItemInput, OfficeTreeInput } from "../tree.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/office/manifest" or directly from "@@agentproto/office/schema".
export { officeFrontmatterSchema, type OfficeFrontmatter }

export interface OfficeManifest {
  frontmatter: OfficeFrontmatter
  body: string
}

export function parseOfficeManifest(source: string): OfficeManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseOfficeManifest: missing or empty frontmatter")
  }
  const result = officeFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseOfficeManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function officeFromManifest(manifest: OfficeManifest): OfficeHandle {
  // The zod-validated frontmatter is structurally compatible with
  // OfficeDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineOffice(manifest.frontmatter as unknown as OfficeDefinition)
}

export interface ReadOfficeTreeOptions {
  /** Folder of the tree root (the company node). */
  root: string
  /** Declared nodes of the tree (AIP-34); `dir` is relative to `root`, "" for the root node. */
  nodes: readonly { ref: string; dir: string }[]
}

/**
 * Read the OFFICE.md of every declared node and the items of the office
 * (`items/<collection>/*.md` under the root) into an `OfficeTreeInput` for
 * `analyzeOfficeTree`. Frontmatter is passed through raw: validation is the
 * analysis's job, so a malformed OFFICE.md surfaces as an issue, not a throw.
 */
export function readOfficeTree(opts: ReadOfficeTreeOptions): OfficeTreeInput {
  const rootNode = opts.nodes.find((n) => n.dir === "")
  if (!rootNode) throw new Error("readOfficeTree: no node with dir \"\" (the tree root)")
  const nodes = opts.nodes.map((n) => {
    const file = join(opts.root, n.dir, "OFFICE.md")
    return existsSync(file)
      ? { ...n, office: matter(readFileSync(file, "utf8")).data }
      : { ...n }
  })
  const items: OfficeItemInput[] = []
  const itemsDir = join(opts.root, "items")
  if (existsSync(itemsDir)) {
    for (const collection of readdirSync(itemsDir).sort()) {
      const dir = join(itemsDir, collection)
      for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith(".md")) continue
        const data = matter(readFileSync(join(dir, f), "utf8")).data
        items.push({
          ...data,
          collection: typeof data.collection === "string" ? data.collection : collection,
          id: typeof data.id === "string" ? data.id : f.slice(0, -3),
        })
      }
    }
  }
  return { root: rootNode.ref, nodes, items }
}

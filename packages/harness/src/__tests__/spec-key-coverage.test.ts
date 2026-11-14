/**
 * Key coverage against the vendored AIP-45 draft.
 *
 * `agentCliFrontmatterSchema` is hand-mirrored from
 * `specs/resources/aip-45/draft/HARNESS.schema.json` (not generated, so
 * `check:spec-drift` does not guard it) and is `.strict()`: a root key the
 * draft adds or renames that this schema lacks REJECTS a spec-conformant
 * HARNESS.md. That is how the `adapter` -> `harness` rename broke manifests.
 * This test fails the moment the draft names a root key the schema does not
 * accept. It checks key names only, not their shapes.
 */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { agentCliFrontmatterSchema } from "../schema.js"

const DRAFT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../specs/resources/aip-45/draft/HARNESS.schema.json",
)

/**
 * Draft keys known NOT to be accepted yet, each a tracked gap. Remove an
 * entry when the schema learns the key; never add one to silence a rename.
 * - `gateways`: AIP-45 renamed `presets` to `gateways` (vendored in #2207);
 *   the schema still only reads `presets`.
 */
const KNOWN_GAPS = new Set(["gateways"])

describe("agentCliFrontmatterSchema covers the AIP-45 draft's root keys", () => {
  it("accepts every root property the vendored HARNESS draft declares", () => {
    const draft = JSON.parse(readFileSync(DRAFT, "utf8")) as { properties: Record<string, unknown> }
    const accepted = new Set(Object.keys(agentCliFrontmatterSchema.shape))
    const missing = Object.keys(draft.properties).filter(key => !accepted.has(key) && !KNOWN_GAPS.has(key))
    expect(missing).toEqual([])
  })

  it("lists no known gap the schema already accepts", () => {
    const accepted = new Set(Object.keys(agentCliFrontmatterSchema.shape))
    expect([...KNOWN_GAPS].filter(key => accepted.has(key))).toEqual([])
  })
})

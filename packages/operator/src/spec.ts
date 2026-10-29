/**
 * AIP-9 doctype spec — fed to `@agentproto/manifest.createVerbs` to derive
 * create / load / list / update / resolve / delete in one place. An operator
 * lives at `<dir>/operators/<id>/OPERATOR.md`.
 */

import { createVerbs, type DoctypeSpec } from "@agentproto/manifest"
import matter from "gray-matter"
import { defineOperator } from "./define-operator.js"
import { parseOperatorManifest } from "./manifest/index.js"
import { renderOperatorMd } from "./render.js"
import type { OperatorDefinition, OperatorHandle } from "./types.js"

export const operatorSpec: DoctypeSpec<OperatorDefinition, OperatorHandle> = {
  name: "operator",
  aip: 9,
  schemaLiteral: "operator/v1",
  pathOf: (h) => `operators/${h.id}/OPERATOR.md`,
  define: defineOperator,
  render: (handle, body) => renderOperatorMd({ operator: handle, body }),
  parse: (source) => {
    const m = parseOperatorManifest(source)
    // Validated above; the file's own fields come back, so an update does not
    // write schema defaults into a file that never carried them.
    return { frontmatter: structuredClone(matter(source).data), body: m.body }
  },
}

export const operatorVerbs = createVerbs(operatorSpec)

/**
 * Test helper — load the actual AgentProto JSON Schemas from
 * `projects/agentproto/agentproto/specs/resources/aip-XX/draft/` into
 * an AipSchemaBundle the validator can consume.
 *
 * Real hosts (cloud adapter / local CLI) get the bundle from their
 * own boot-time wiring; this helper lets tests reuse the spec
 * directly without duplicating the schema content.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { AipSchemaBundle } from "../../validate/validator.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// src/__tests__/_helpers → src/__tests__ → src → corpus → packages → ts → agentproto/
// then the spec lives at agentproto/agentproto/specs/resources
const SPECS_ROOT = path.resolve(
  __dirname,
  "../../../../../../agentproto/specs/resources"
)

function loadSchema(aip: number, doctype: string): unknown {
  const file = path.join(SPECS_ROOT, `aip-${aip}`, "draft", `${doctype}.schema.json`)
  return JSON.parse(readFileSync(file, "utf8"))
}

export function loadAipSchemaBundle(): AipSchemaBundle {
  return {
    schemas: {
      knowledge: loadSchema(10, "KNOWLEDGE"),
      collection: loadSchema(18, "COLLECTION"),
      playbook: loadSchema(12, "PLAYBOOK"),
      operator: loadSchema(9, "OPERATOR"),
      workflow: loadSchema(15, "WORKFLOW"),
      routine: loadSchema(41, "ROUTINE"),
    },
    externals: [loadSchema(16, "IO"), loadSchema(17, "RUNNER")],
  }
}

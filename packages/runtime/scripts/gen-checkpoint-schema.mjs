#!/usr/bin/env node
/**
 * Regenerate schemas/checkpoint.v1.json from the zod contract in
 * src/checkpoint-schema.ts. A test fails when the committed file drifts.
 *
 *   pnpm --filter @agentproto/runtime gen:checkpoint-schema
 */
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildCheckpointJsonSchema } from "../src/checkpoint-schema.ts"

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "checkpoint.v1.json")
writeFileSync(out, `${JSON.stringify(buildCheckpointJsonSchema(), null, 2)}\n`)
console.log(`wrote ${out}`)

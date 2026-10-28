/**
 * JSON Schema for `mastra.agent-controller/v1`, derived from the zod schema
 * in `./manifest.ts` so the two cannot disagree. The committed copy lives at
 * `schema/mastra.agent-controller.v1.schema.json`; a test fails when it
 * drifts from this function's output (`pnpm schema:write` regenerates it).
 *
 * Cross-field rules (one default mode, `transitionsTo` naming a declared
 * mode, unique ids) are zod refinements and have no JSON Schema form: only
 * `parseControllerManifest` enforces them.
 */

import { z } from "zod"
import { CONTROLLER_MANIFEST_ID, ControllerManifestSchema } from "./manifest.js"

export function controllerManifestJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(ControllerManifestSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>
  const { $schema, ...rest } = generated
  return {
    $schema,
    title: CONTROLLER_MANIFEST_ID,
    description:
      "Manifest for one Mastra AgentController, read by @agentproto/adapter-mastra-controller.",
    ...rest,
  }
}

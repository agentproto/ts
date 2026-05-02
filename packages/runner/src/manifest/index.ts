/**
 * AIP-17 RUNNER.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineRunner` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-17/draft/RUNNER.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { runnerFrontmatterSchema, type RunnerFrontmatter } from "../schema.js"
import { defineRunner } from "../define-runner.js"
import type { RunnerDefinition, RunnerHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/runner/manifest" or directly from "@@agentproto/runner/schema".
export { runnerFrontmatterSchema, type RunnerFrontmatter }

export interface RunnerManifest {
  frontmatter: RunnerFrontmatter
  body: string
}

export function parseRunnerManifest(source: string): RunnerManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseRunnerManifest: missing or empty frontmatter")
  }
  const result = runnerFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseRunnerManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function runnerFromManifest(manifest: RunnerManifest): RunnerHandle {
  // The zod-validated frontmatter is structurally compatible with
  // RunnerDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineRunner(manifest.frontmatter as unknown as RunnerDefinition)
}

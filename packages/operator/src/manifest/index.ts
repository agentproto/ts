/**
 * AIP-9 OPERATOR.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest`, `@agentproto/driver/manifest`,
 * and `@agentproto/governance/policy`: the .md provides metadata; the
 * TS module routes it through `defineOperator` so AIP-9 invariants
 * (cross-field rules, ref shapes, length caps) run uniformly with the
 * TS authoring path.
 *
 * The frontmatter schema mirrors `OPERATOR.schema.json`
 * (resources/aip-9/draft/) field-for-field. AIP-9 forbids
 * `additionalProperties` at every nested level, so we use plain
 * `.object({...})` (strict) — extra keys raise a helpful error
 * instead of silently surviving.
 */

import matter from "gray-matter"
import { z } from "zod"
import { defineOperator } from "../define-operator.js"
import type { OperatorHandle } from "../types.js"

const skillRefSchema = z.union([
  z.string().regex(/^[a-z][a-z0-9-]*[a-z0-9]$/),
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*[a-z0-9]$/),
    source: z.string().optional(),
    version: z.string().optional(),
    allow: z.array(z.string()).optional(),
  }),
])

const toolRefSchema = z.union([
  z.string().regex(/^[a-z][a-z0-9-]*[a-z0-9]$/),
  z.object({
    id: z.string(),
    source: z.string().optional(),
    scope: z
      .object({
        workspace: z.string().optional(),
        network: z.array(z.string()).optional(),
        secrets: z.array(z.string()).optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("mcp"),
    server: z.string(),
    allow: z.array(z.string()).optional(),
  }),
])

export const operatorManifestFrontmatterSchema = z.object({
  schema: z.literal("agentoperator/v1").optional(),
  name: z.string().min(1).max(80),
  id: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/),
  persona_summary: z.string().min(1).max(280),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
  entry: z.string().optional(),
  profile: z.object({
    role: z.string().min(1).max(1000),
    voice: z.string().min(1).max(1000),
    boundaries: z.array(z.string().max(500)),
  }),
  skills: z.array(skillRefSchema).optional(),
  tools: z.array(toolRefSchema).optional(),
  memory: z
    .object({
      kind: z.enum(["none", "thread", "operator-context", "external"]),
      policy: z.enum(["append-only", "redactable", "summarising"]).optional(),
      share_with: z
        .array(z.string().regex(/^[a-z][a-z0-9-]*[a-z0-9]$/))
        .optional(),
      external: z
        .object({ uri: z.string(), namespace: z.string().optional() })
        .optional(),
    })
    .optional(),
  governance: z
    .object({
      policies: z.array(z.string().regex(/^policy:[A-Za-z0-9_./-]+$/)).optional(),
      audit_log: z.string().regex(/^audit:[A-Za-z0-9_./-]+$/),
      autonomy: z.enum(["autonomous", "supervised", "gated"]),
    })
    .optional(),
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).optional(),
  participation: z
    .object({
      mode: z.enum(["mention-only", "proactive", "silent"]).optional(),
      pass_when: z.string().optional(),
      reactions: z.boolean().optional(),
    })
    .optional(),
  tags: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type OperatorManifestFrontmatter = z.infer<
  typeof operatorManifestFrontmatterSchema
>

export interface OperatorManifest {
  frontmatter: OperatorManifestFrontmatter
  body: string
}

export function parseOperatorManifest(source: string): OperatorManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseOperatorManifest: missing or empty frontmatter")
  }
  const result = operatorManifestFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseOperatorManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function operatorFromManifest(manifest: OperatorManifest): OperatorHandle {
  const fm = manifest.frontmatter
  return defineOperator({
    id: fm.id,
    name: fm.name,
    persona_summary: fm.persona_summary,
    version: fm.version,
    entry: fm.entry,
    profile: fm.profile,
    skills: fm.skills,
    tools: fm.tools,
    memory: fm.memory,
    governance: fm.governance,
    capabilities: fm.capabilities,
    participation: fm.participation,
    tags: fm.tags,
    metadata: fm.metadata,
  })
}

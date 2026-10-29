/**
 * AIP-9 OPERATOR.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest`, `@agentproto/driver/manifest`,
 * and `@agentproto/governance/policy`: the .md provides metadata; the
 * TS module routes it through `defineOperator` so AIP-9 invariants
 * (cross-field rules, ref shapes, length caps) run uniformly with the
 * TS authoring path.
 *
 * The frontmatter schema tracks the vendored `OPERATOR.schema.json`
 * (resources/aip-9/draft/), and keeps the deprecated item forms (scoped
 * `tools`, `skills`, `memory`, `governance`) the draft still accepts. AIP-9 forbids
 * `additionalProperties` at the top level and in every operator-owned object,
 * so those are strict. The AGENT fields are NOT redeclared: each one is taken
 * from `agentFrontmatterSchema.shape` so a tightening of AIP-42 reaches the
 * operator with no edit here.
 */

import { agentFrontmatterSchema } from "@agentproto/agent"
import matter from "gray-matter"
import { z } from "zod"
import {
  defineOperator,
  isLegacyGovernance,
  isLegacyMemory,
} from "../define-operator.js"
import type {
  DefineOperatorOptions,
  OperatorDefinition,
  OperatorHandle,
} from "../types.js"

const agentShape = agentFrontmatterSchema.shape

/**
 * An AGENT field as an operator accepts it: the same schema, but optional and
 * without the AGENT default, so reading an operator never invents a value.
 */
function agentField<K extends keyof typeof agentShape>(key: K) {
  const field: z.ZodType = agentShape[key]
  const bare = field instanceof z.ZodDefault ? field.unwrap() : field
  return (bare as z.ZodType).optional()
}

const SLUG = /^[a-z][a-z0-9-]*[a-z0-9]$/
const KEBAB = /^[a-z][a-z0-9-]*$/

/** AIP-42 `anyRef`: a string shorthand or `{ ref | file | inline }`. */
const anyRefSchema = z.union([
  z.string().min(1),
  z
    .object({
      ref: z.string().min(1).optional(),
      file: z.string().min(1).optional(),
      inline: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
])

/** The AGENT `tools` item (AIP-42 `toolRef`: an AIP-54 ref or an `mcp` server ref), taken from the AGENT schema. */
const agentToolItemSchema = (agentShape.tools as unknown as z.ZodDefault<z.ZodArray<z.ZodType>>)
  .unwrap()
  .element

/** Deprecated: an AIP-14 tool narrowed for this operator. */
const legacyScopedToolRefSchema = z
  .object({
    id: z.string(),
    source: z.string().optional(),
    scope: z
      .object({
        workspace: z.string().optional(),
        network: z.array(z.string()).optional(),
        secrets: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

/** Deprecated: an AIP-3 skill pinned for this operator. */
const legacySkillRefSchema = z
  .object({
    id: z.string().regex(SLUG),
    source: z.string().optional(),
    version: z.string().optional(),
    allow: z.array(z.string()).optional(),
  })
  .strict()

const legacyMemorySchema = z
  .object({
    kind: z.enum(["none", "thread", "operator-context", "external"]),
    policy: z.enum(["append-only", "redactable", "summarising"]).optional(),
    share_with: z.array(z.string().regex(SLUG)).optional(),
    external: z
      .object({ uri: z.string(), namespace: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict()

const legacyGovernanceSchema = z
  .object({
    policies: z.array(z.string().regex(/^policy:[A-Za-z0-9_./-]+$/)).optional(),
    audit_log: z.string().regex(/^audit:[A-Za-z0-9_./-]+$/),
    autonomy: z.enum(["autonomous", "supervised", "gated"]),
  })
  .strict()

/**
 * The AGENT form is accepted as the AGENT schema accepts it. An object written
 * in the deprecated form (recognised by its keys) is held to the deprecated
 * shape instead, so a typo in it is reported, not passed through as AGENT data.
 */
function agentOrLegacy(
  key: "memory" | "governance",
  isLegacy: (v: unknown) => boolean,
  legacy: z.ZodType,
) {
  return agentField(key).superRefine((value, ctx) => {
    if (!isLegacy(value)) return
    const result = legacy.safeParse(value)
    if (result.success) return
    for (const issue of result.error.issues) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message })
    }
  })
}

const roleSchema = z.union([
  z.string().min(1),
  z
    .object({
      ref: z.string().min(1),
      bind: z.record(z.string(), agentToolItemSchema).optional(),
      with: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional(),
    })
    .strict(),
])

export const operatorManifestFrontmatterSchema = z
  .object({
    // "operator/v1" is the AIP-70 registry name; "agentoperators/v1" and
    // "agentoperator/v1" (singular) are the deprecated pre-AIP-9 spellings;
    // all three are still accepted.
    schema: z
      .enum(["operator/v1", "agentoperators/v1", "agentoperator/v1"])
      .optional(),
    name: z.string().min(1).max(80),
    id: z.string().min(2).max(64).regex(SLUG),
    persona_summary: z.string().min(1).max(280),
    entry: z.string().optional(),
    role: roleSchema.optional(),
    home: anyRefSchema.optional(),
    company: anyRefSchema.optional(),
    reports_to: z.string().min(2).max(64).regex(SLUG).optional(),

    // AGENT fields, by reference to the AGENT schema.
    version: agentField("version"),
    description: agentField("description"),
    extends: agentField("extends"),
    model: agentField("model"),
    identity: agentField("identity"),
    persona: agentField("persona"),
    runner: agentField("runner"),
    actions: agentField("actions"),
    workflows: agentField("workflows"),
    routines: agentField("routines"),
    delegates_to: agentField("delegates_to"),
    policy: agentField("policy"),
    traits: agentField("traits"),
    autonomy: agentField("autonomy"),
    boundaries: agentField("boundaries"),
    on: agentField("on"),
    publish: agentField("publish"),
    tags: z.array(z.string().regex(KEBAB)).optional(),
    metadata: agentField("metadata"),

    // AGENT item shapes widened by what an operator also accepts: the
    // deprecated forms are tried first, then the AGENT item schema itself, so
    // an invalid item is rejected instead of swallowed by a loose member.
    skills: z
      .array(z.union([legacySkillRefSchema, anyRefSchema]))
      .optional(),
    tools: z
      .array(z.union([legacyScopedToolRefSchema, agentToolItemSchema]))
      .optional(),
    memory: agentOrLegacy("memory", isLegacyMemory, legacyMemorySchema),
    governance: agentOrLegacy(
      "governance",
      isLegacyGovernance,
      legacyGovernanceSchema,
    ),

    capabilities: z.array(z.string().regex(KEBAB)).optional(),
    participation: z
      .object({
        mode: z.enum(["mention-only", "proactive", "silent"]).optional(),
        pass_when: z.string().optional(),
        reactions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    runtime: z
      .object({
        kind: z.enum(["in-process", "agent-cli"]),
        ref: z.string().optional(),
        session: z
          .object({
            mode: z.enum(["ephemeral", "persistent", "resumable"]).optional(),
            idle_timeout_ms: z.number().int().min(1000).optional(),
          })
          .strict()
          .optional(),
        config: z
          .object({
            mode: z.string().optional(),
            options: z.record(z.string(), z.unknown()).optional(),
            continuation: z
              .enum(["none", "pinned-session", "transcript", "native-resume"])
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    profile: z
      .object({
        role: z.string().min(1).max(1000).optional(),
        voice: z.string().min(1).max(1000).optional(),
        boundaries: z.array(z.string().max(500)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

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

export function operatorFromManifest(
  manifest: OperatorManifest,
  options?: DefineOperatorOptions,
): OperatorHandle {
  const { schema: _schema, ...definition } = manifest.frontmatter
  return defineOperator(definition as OperatorDefinition, options)
}

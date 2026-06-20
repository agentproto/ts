import matter from "gray-matter"
import { z, type ZodType } from "zod"
import { defineTool } from "../define-tool.js"
import type { ApprovalClass, ToolContext, ToolHandle } from "../types.js"

/**
 * AIP-14 TOOL.md sidecar parser.
 *
 * Reads frontmatter (host-relevant metadata) + body (long-form
 * description / examples / errors). The TS module's `defineTool(...)`
 * supplies the schemas and execute body; this manifest supplies the
 * runtime metadata that overrides or augments the in-code defaults.
 *
 * Field set covers AIP-14 §"Frontmatter" — required and optional fields
 * normalised to snake_case → camelCase.
 */

export const toolManifestFrontmatterSchema = z.object({
  schema: z.literal("agentproto/tool/v1").optional(),
  name: z.string().min(1).max(80),
  id: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/),
  description: z.string().min(1).max(2000),
  version: z.string().regex(/^\d+\.\d+\.\d+/),

  // Optional metadata
  mutates: z.array(z.string()).optional(),
  requires: z
    .object({
      network: z.array(z.string()).optional(),
      secrets: z.array(z.string()).optional(),
      tools: z.array(z.string()).optional(),
    })
    .optional(),
  // `ApprovalClass` is `"auto" | "always" | "on-mutate" | \`policy:${string}\``.
  // z.union widens the regex branch to plain `string` (zod can't express
  // template literal types), so we use `z.custom` to keep the inferred
  // type exact — matters because `defineTool` accepts `ApprovalClass`.
  approval: z
    .custom<ApprovalClass>(
      (v): v is ApprovalClass =>
        typeof v === "string" &&
        (v === "auto" ||
          v === "always" ||
          v === "on-mutate" ||
          /^policy:/.test(v)),
      { message: "expected 'auto' | 'always' | 'on-mutate' | 'policy:<name>'" },
    )
    .optional(),
  risk_level: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .optional(),
  cost_class: z.enum(["trivial", "metered", "expensive"]).optional(),
  timeout_ms: z.number().int().positive().optional(),
  idempotent: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),

  // AIP-16 IO blocks — `inputs`/`outputs` as JSON Schema objects. Kept
  // structurally loose here (validated as objects, not deep-checked against
  // the AIP-16 meta-schema); preserved so a manifest's declared IO contract
  // survives the parse → handle round-trip instead of being silently dropped.
  inputs: z.record(z.string(), z.unknown()).optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),

  // AIP-26 / AIP-17 / AIP-19 references — kept loose; validated by their
  // respective AIPs' adapters when consumed.
  code: z.unknown().optional(),
  run: z.unknown().optional(),
  runner: z.unknown().optional(),
  secrets: z.unknown().optional(),
  network: z.unknown().optional(),
})

export type ToolManifestFrontmatter = z.infer<
  typeof toolManifestFrontmatterSchema
>

export interface ToolManifest {
  frontmatter: ToolManifestFrontmatter
  body: string
}

/**
 * Parse a TOOL.md source string into structured frontmatter + body.
 * Throws on missing frontmatter or schema-invalid frontmatter.
 */
export function parseToolManifest(source: string): ToolManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseToolManifest: missing or empty frontmatter")
  }
  const result = toolManifestFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseToolManifest: invalid frontmatter — ${result.error.issues
        .map(i => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

/**
 * Build a fully-typed {@link ToolHandle} from a parsed `TOOL.md` manifest
 * + caller-supplied schemas. The .md is the single source of truth for
 * metadata (id, name, description, version, mutates, approval, …); the
 * schemas live in the TS module that ships alongside the .md.
 *
 * Both inputs are revalidated by `defineTool`'s shared invariants
 * (id pattern, description length, top-level freeze) — `parseToolManifest`
 * already enforces a stricter id pattern + version semver, so a
 * well-formed manifest passes through cleanly. Mismatches between the
 * manifest's id-shape and `defineTool`'s pattern surface a
 * descriptive error from the same validation pipeline as the TS path.
 *
 * @example
 *   const manifest = parseToolManifest(readFileSync("./echo/TOOL.md", "utf8"))
 *   const echo = toolFromManifest({
 *     manifest,
 *     inputSchema: z.object({ msg: z.string() }),
 *     outputSchema: z.object({ msg: z.string() }),
 *   })
 */
export function toolFromManifest<
  TInput,
  TOutput,
  TContext extends ToolContext = ToolContext,
>(args: {
  manifest: ToolManifest
  inputSchema: ZodType<TInput>
  outputSchema: ZodType<TOutput>
  contextSchema?: ZodType<TContext>
}): ToolHandle<TInput, TOutput, TContext> {
  const fm = args.manifest.frontmatter
  return defineTool<TInput, TOutput, TContext>({
    id: fm.id,
    name: fm.name,
    description: fm.description,
    version: fm.version,
    inputSchema: args.inputSchema,
    outputSchema: args.outputSchema,
    inputs: fm.inputs,
    outputs: fm.outputs,
    contextSchema: args.contextSchema,
    mutates: fm.mutates,
    requires: fm.requires,
    approval: fm.approval,
    riskLevel: fm.risk_level,
    costClass: fm.cost_class,
    timeoutMs: fm.timeout_ms,
    idempotent: fm.idempotent,
    tags: fm.tags,
    metadata: fm.metadata,
  })
}

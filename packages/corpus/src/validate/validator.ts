/**
 * CorpusValidator — validate a workspace snapshot against the AIP JSON
 * Schemas (the spec source-of-truth at
 * projects/agentproto/agentproto/specs/resources/aip-XX/draft/).
 *
 * The validator is constructed once with an AJV instance pre-loaded
 * with every referenced schema, then run against a `ParsedFile` or a
 * whole `CorpusWorkspaceSnapshot`. Schema loading is delegated to a
 * factory function so the kit doesn't carry the spec JSON inside — the
 * host (cloud adapter or local CLI) supplies the schemas at boot.
 *
 * Why AJV not zod: the AgentProto zod schemas at @agentproto/(aip)/schema
 * are partially generated stubs today (z.any() oneOf branches in
 * knowledge/collection/playbook). AJV against the canonical JSON
 * Schemas is the authoritative path until the zod stubs are
 * regenerated from the JSON Schemas. The corpus kit is the place that
 * exercises both, so this discipline matters.
 */

import type { ValidateFunction } from "ajv/dist/2020.js"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import type {
  CorpusWorkspaceSnapshot,
  FileKind,
  ParsedFile,
  ValidationIssue,
  ValidationResult,
} from "../types.js"

/**
 * Map from FileKind → JSON Schema key. The schema bundle the host
 * supplies must include these keys.
 */
export type AipSchemaKey =
  | "knowledge"       // AIP-10 — entries, sources, workspace (oneOf inside)
  | "collection"      // AIP-18 — both COLLECTION.md (schema) and ITEM.md (item)
  | "playbook"        // AIP-12
  | "operator"        // AIP-9
  | "workflow"        // AIP-15
  | "routine"         // AIP-41

export interface AipSchemaBundle {
  /** Schemas keyed by AIP doctype. Values are JSON Schema documents. */
  readonly schemas: Readonly<Record<AipSchemaKey, unknown>>
  /**
   * External schemas to register with AJV before compilation (so
   * `$ref` cross-document references resolve). The known cross-refs
   * today are AIP-16 IO and AIP-17 RUNNER.
   */
  readonly externals?: ReadonlyArray<unknown>
}

const FILE_KIND_TO_SCHEMA: Partial<Record<FileKind, AipSchemaKey>> = {
  "knowledge-workspace": "knowledge",
  "knowledge-source": "knowledge",
  "knowledge-entry": "knowledge",
  "collection-schema": "collection",
  "collection-item": "collection",
  "playbook": "playbook",
  "operator": "operator",
  "workflow": "workflow",
  "routine": "routine",
}

export interface CorpusValidatorOptions {
  readonly bundle: AipSchemaBundle
}

export class CorpusValidator {
  private readonly validators: Readonly<Record<AipSchemaKey, ValidateFunction>>
  /**
   * Per-doctype map of `schema:` discriminator value → validator for
   * that single oneOf branch (e.g. "knowledge.source/v1" → the AIP-10
   * source branch). Built from each schema's `oneOf` of local `$refs`
   * whose target declares `properties.schema.const`. Used to report
   * the RIGHT branch's errors when a file declares its doctype
   * explicitly, instead of ajv's full oneOf fan-out (which buries the
   * one real error under every other branch's missing-property noise).
   */
  private readonly branchValidators: ReadonlyMap<
    AipSchemaKey,
    ReadonlyMap<string, ValidateFunction>
  >

  constructor(opts: CorpusValidatorOptions) {
    const ajv = new Ajv2020({
      strict: false,
      allErrors: true,
      allowUnionTypes: true,
    })
    addFormats(ajv)

    // Register externals first so refs from doctype schemas resolve.
    for (const ext of opts.bundle.externals ?? []) {
      const id = (ext as { $id?: string }).$id
      if (id && !ajv.getSchema(id)) ajv.addSchema(ext as object)
    }

    const validators: Record<AipSchemaKey, ValidateFunction> = {} as Record<
      AipSchemaKey,
      ValidateFunction
    >
    const branches = new Map<AipSchemaKey, ReadonlyMap<string, ValidateFunction>>()
    for (const key of Object.keys(opts.bundle.schemas) as AipSchemaKey[]) {
      validators[key] = ajv.compile(opts.bundle.schemas[key] as object)
      branches.set(key, compileBranchValidators(ajv, opts.bundle.schemas[key]))
    }
    this.validators = validators
    this.branchValidators = branches
  }

  /**
   * Validate a single parsed file. Returns issues + a valid flag.
   * Unknown FileKind ("unknown" bucket) is reported as a single info
   * issue — the file exists but doesn't fit AIP conventions.
   */
  validateFile(file: ParsedFile): ValidationResult {
    if (file.kind === "unknown") {
      return {
        valid: false,
        issues: [
          {
            path: file.path,
            instancePath: "/",
            message:
              "file location does not match any AIP convention; expected under sources/, entries/, collections/, playbooks/, operators/, workflows/, or routines/",
            severity: "info",
          },
        ],
      }
    }

    const schemaKey = FILE_KIND_TO_SCHEMA[file.kind]
    if (!schemaKey) {
      // Defensive — shouldn't happen, but never throw on classification drift.
      return {
        valid: true,
        issues: [],
      }
    }

    // When the frontmatter declares its doctype explicitly (an AIP-10
    // `schema:` discriminator like "knowledge.source/v1"), validate
    // against THAT oneOf branch only, so the reported errors are the
    // declared doctype's (e.g. "authority must be one of
    // primary|secondary|rumour") — not the sibling branches' missing
    // slug/kind/additionalProperties noise. Falls back to the full
    // doctype schema when `schema:` is absent or names no branch of
    // the location-selected doctype.
    const declared = file.frontmatter["schema"]
    const branchValidator =
      typeof declared === "string"
        ? this.branchValidators.get(schemaKey)?.get(declared)
        : undefined

    const validator = branchValidator ?? this.validators[schemaKey]
    const ok = validator(file.frontmatter)
    if (ok) return { valid: true, issues: [] }

    const issues: ValidationIssue[] = (validator.errors ?? []).map((e) => ({
      path: file.path,
      instancePath: e.instancePath || "/",
      message: `${e.message}${
        e.params && Object.keys(e.params).length > 0
          ? ` (${JSON.stringify(e.params)})`
          : ""
      }`,
      severity: "error" as const,
    }))
    return { valid: false, issues }
  }

  /**
   * Validate every file in a workspace snapshot. Returns a flat list
   * of issues across all files plus a `valid` flag that's true only
   * if zero error-severity issues exist.
   */
  validateWorkspace(snapshot: CorpusWorkspaceSnapshot): ValidationResult {
    const all: ValidationIssue[] = []
    const buckets: ReadonlyArray<readonly ParsedFile[]> = [
      snapshot.workspace ? [snapshot.workspace] : [],
      snapshot.sources,
      snapshot.entries,
      snapshot.collections,
      snapshot.collectionItems,
      snapshot.playbooks,
      snapshot.operators,
      snapshot.workflows,
      snapshot.routines,
      snapshot.unknown,
    ]
    for (const bucket of buckets) {
      for (const file of bucket) {
        all.push(...this.validateFile(file).issues)
      }
    }
    return {
      valid: all.every((i) => i.severity !== "error"),
      issues: Object.freeze(all),
    }
  }
}

// ── Branch-validator compilation ─────────────────────────────────────

interface OneOfSchemaDoc {
  readonly oneOf?: readonly unknown[]
  readonly $defs?: Readonly<Record<string, unknown>>
}

/**
 * For a doctype schema shaped as `oneOf: [{$ref: "#/$defs/…"}, …]` where
 * each branch declares a `properties.schema.const` discriminator (the
 * AIP-10 / AIP-18 pattern), compile each branch standalone — the parent's
 * `$defs` carried along so internal `#/$defs/…` refs keep resolving, no
 * `$id` so it never collides with the registered full schema — and key it
 * by its discriminator value. Schemas without such a oneOf yield an
 * empty map (their full-document validator already reports crisply).
 */
function compileBranchValidators(
  ajv: Ajv2020,
  schemaDoc: unknown
): ReadonlyMap<string, ValidateFunction> {
  const out = new Map<string, ValidateFunction>()
  if (typeof schemaDoc !== "object" || schemaDoc === null) return out
  const doc = schemaDoc as OneOfSchemaDoc
  if (!Array.isArray(doc.oneOf)) return out

  for (const branch of doc.oneOf) {
    const resolved = resolveLocalRef(doc, branch)
    const discriminator = discriminatorOf(resolved)
    if (!discriminator || out.has(discriminator)) continue
    const standalone: Record<string, unknown> = {
      $defs: doc.$defs ?? {},
      ...(branch as Record<string, unknown>),
    }
    out.set(discriminator, ajv.compile(standalone))
  }
  return out
}

/** Resolve a local `{$ref: "#/$defs/x"}` branch against its own document. */
function resolveLocalRef(doc: OneOfSchemaDoc, branch: unknown): unknown {
  if (typeof branch !== "object" || branch === null) return branch
  const ref = (branch as { $ref?: unknown }).$ref
  if (typeof ref !== "string" || !ref.startsWith("#/")) return branch
  let node: unknown = doc
  for (const seg of ref.slice(2).split("/")) {
    if (typeof node !== "object" || node === null) return undefined
    node = (node as Record<string, unknown>)[
      seg.replace(/~1/g, "/").replace(/~0/g, "~")
    ]
  }
  return node
}

/** Read a branch's `properties.schema.const` discriminator, if any. */
function discriminatorOf(branchDef: unknown): string | undefined {
  if (typeof branchDef !== "object" || branchDef === null) return undefined
  const props = (branchDef as { properties?: unknown }).properties
  if (typeof props !== "object" || props === null) return undefined
  const schemaProp = (props as { schema?: unknown }).schema
  if (typeof schemaProp !== "object" || schemaProp === null) return undefined
  const c = (schemaProp as { const?: unknown }).const
  return typeof c === "string" ? c : undefined
}

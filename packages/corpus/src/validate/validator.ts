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
    for (const key of Object.keys(opts.bundle.schemas) as AipSchemaKey[]) {
      validators[key] = ajv.compile(opts.bundle.schemas[key] as object)
    }
    this.validators = validators
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

    const validator = this.validators[schemaKey]
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

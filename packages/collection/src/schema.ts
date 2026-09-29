/**
 * AIP-18 COLLECTION.md frontmatter zod schema.
 *
 * Generated from `resources/aip-18/draft/COLLECTION.schema.json` via
 * json-schema-to-zod (`scripts/scaffold-aip.mjs --schema-only`). Imported
 * by both `define-collection.ts` (TS path validation) and
 * `manifest/index.ts` (.md path validation) so every field-level
 * constraint runs in both authoring paths from a single source of truth
 * — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly. The top-level one (`appliesTo` non-empty => `extends`) lives in
 * `define-collection.ts`'s `validate(def)`; the per-field ones
 * (`type: enum` => `enum`, `type: array` => `items`, `type: ref` =>
 * `refKind`) are hand-written below as `requireCompanionKeys` (fix 2c).
 *
 * Hand-fixes on top of the generator's output:
 *
 * 1. The top-level `oneOf` (discriminated on `schema`) — the generic
 *    json-schema-to-zod path collapses a top-level `oneOf` of `$ref`s
 *    into a `z.any().superRefine(...)` block that can never pass (both
 *    branches are visited as `z.any()`, so "exactly one match" is never
 *    true — this was the original unsatisfiable-schema bug). The
 *    scaffolder's `tryDiscriminatedUnion` detects the shared `schema`
 *    const-literal discriminator and emits `z.discriminatedUnion`
 *    directly, which is what's below.
 * 2. `fieldDef` (`$defs/fieldDef`, used by `schema.fields[]`) and
 *    `fieldShape` (`$defs/fieldShape`, the name-less shape used for an
 *    array field's `items:`) are self-referential: `items` is
 *    `$ref: #/$defs/fieldShape`, which recurses into itself (nested array
 *    field types, e.g. an array-of-array-of-string). json-schema-to-zod
 *    can't express recursive refs and silently degrades them to
 *    `z.any()`, which would accept any `fields[]` shape at all.
 *    Hand-written below as `fieldDefSchema` and `fieldItemsSchema`
 *    (= `$defs/fieldShape`) using `z.lazy` instead of relying on the
 *    generator for those nodes. The two mirror the JSON Schema
 *    field-for-field; `fieldItemsSchema` is `fieldDefSchema` minus `name`,
 *    and being `.strict()` it REJECTS a `name` inside `items` (`name` is
 *    required, and only meaningful, for `fields[]` entries).
 * 2c. `$defs/fieldDef` and `$defs/fieldShape` carry `allOf` if/then rules:
 *    `type: enum` requires `enum`, `type: array` requires `items`,
 *    `type: ref` requires `refKind`. Enforced by `requireCompanionKeys`,
 *    a `superRefine` applied to both hand-written schemas (so it also
 *    runs at every `items:` depth).
 * 3. `collection.item/v1`'s `createdAt` / `updatedAt` are `z.string()`
 *    per the JSON Schema's `format: date-time`, but gray-matter's YAML
 *    parser (js-yaml) auto-resolves an unquoted ISO-8601 timestamp
 *    scalar (e.g. `2026-04-26T09:14:00Z`, exactly what `EXAMPLES.md`
 *    uses) into a native `Date` — before the value ever reaches zod.
 *    Both fields accept `string | Date` and normalize to an ISO
 *    string so the parsed frontmatter always matches the spec's typed
 *    shape regardless of whether the YAML author quoted the value. The
 *    spec sanctions this: producers SHOULD quote timestamps, consumers
 *    MAY accept native ones (AIP-18 ITEM.md, "Timestamps and dates").
 */

import { z } from "zod"
import type { FieldDef, FieldShape } from "./types.js"

// Hand-written — see fix (2c) in the file banner. Mirrors the `allOf`
// if/then rules on `$defs/fieldDef` and `$defs/fieldShape`.
const COMPANION_KEYS = [
  ["enum", "enum"],
  ["array", "items"],
  ["ref", "refKind"],
] as const

function requireCompanionKeys(
  field: { type: string } & Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  for (const [type, key] of COMPANION_KEYS) {
    if (field.type === type && field[key] === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required when type=${type}`,
      })
    }
  }
}

// Hand-written — see fixes (2) and (2c) in the file banner. Mirrors
// `$defs/fieldShape`: used only for the recursive `items` property, has
// no `name` (strict, so a `name` here is rejected); mirrors
// fieldDefSchema otherwise.
export const fieldItemsSchema: z.ZodType<FieldShape> = z.lazy(() =>
  z
    .object({
      type: z
        .enum([
          "string",
          "number",
          "boolean",
          "enum",
          "date",
          "datetime",
          "text",
          "url",
          "ref",
          "array",
        ])
        .describe(
          "Field type. Drift across composition (parent string -> child number) is HARD refused (`collection_field_type_drift`).",
        ),
      required: z
        .boolean()
        .describe(
          "Whether items MUST declare this field. A child may narrow false -> true; loosening true -> false is permitted (it removes a constraint without invalidating instances).",
        )
        .default(false),
      description: z
        .string()
        .max(1000)
        .describe("Prose describing what the field captures.")
        .optional(),
      enum: z
        .array(z.string())
        .refine((arr) => arr.every((item, i) => arr.indexOf(item) === i), {
          message: "All items must be unique!",
        })
        .describe(
          "Required when type=enum. Children may narrow to a subset; widening to a superset is permitted (it does not invalidate instances).",
        )
        .optional(),
      items: fieldItemsSchema
        .describe(
          "Required when type=array. Recursive shape — describes the inner item type. Carries no `name` (see `fieldShape`).",
        )
        .optional(),
      refKind: z
        .string()
        .regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$"))
        .describe(
          "Required when type=ref. The target collection's `name`. Hosts validate that ref values point at items of this collection.",
        )
        .optional(),
      pattern: z
        .string()
        .describe("OPTIONAL regex constraint. Only valid when type=string.")
        .optional(),
      min: z
        .number()
        .describe(
          "OPTIONAL minimum. For type=number: minimum value. For type=array: minimum length.",
        )
        .optional(),
      max: z
        .number()
        .describe(
          "OPTIONAL maximum. For type=number: maximum value. For type=array: maximum length.",
        )
        .optional(),
      format: z
        .string()
        .describe(
          "OPTIONAL named format. Common values: email, uri, semver, uuid, slug. Only valid when type=string. Hosts MAY interpret unknown formats as advisory.",
        )
        .optional(),
      enabled: z
        .boolean()
        .describe(
          "OPTIONAL deprecation flag. A child may set false to mark an inherited field deprecated; the host preserves the field in the resolved schema (so existing items still validate) but flags new uses via lint. Setting enabled:false on a field a child does not inherit is invalid.",
        )
        .default(true),
    })
    .strict()
    .superRefine(requireCompanionKeys)
    .describe(
      "Name-less field definition: the shape of an array field's `items:`. Identical to `fieldDef` minus `name` — an inner value type has no name of its own, and `name` is only meaningful (and required) for entries in `fields[]`. Keep the two property lists in sync.",
    ),
)

// Hand-written — see fix (2) in the file banner. Mirrors `$defs/fieldDef`
// in COLLECTION.schema.json field-for-field; `items` recurses into
// `fieldItemsSchema` (see fix 2) since the JSON Schema ref is
// self-referential.
export const fieldDefSchema: z.ZodType<FieldDef> = z.lazy(() =>
  z
    .object({
      name: z
        .string()
        .regex(new RegExp("^[a-z][a-zA-Z0-9_]*$"))
        .min(1)
        .max(64)
        .describe(
          "kebab-or-camel-case field name. Merge key when composing.",
        ),
      type: z
        .enum([
          "string",
          "number",
          "boolean",
          "enum",
          "date",
          "datetime",
          "text",
          "url",
          "ref",
          "array",
        ])
        .describe(
          "Field type. Drift across composition (parent string -> child number) is HARD refused (`collection_field_type_drift`).",
        ),
      required: z
        .boolean()
        .describe(
          "Whether items MUST declare this field. A child may narrow false -> true; loosening true -> false is permitted (it removes a constraint without invalidating instances).",
        )
        .default(false),
      description: z
        .string()
        .max(1000)
        .describe("Prose describing what the field captures.")
        .optional(),
      enum: z
        .array(z.string())
        .refine((arr) => arr.every((item, i) => arr.indexOf(item) === i), {
          message: "All items must be unique!",
        })
        .describe(
          "Required when type=enum. Children may narrow to a subset; widening to a superset is permitted (it does not invalidate instances).",
        )
        .optional(),
      items: fieldItemsSchema
        .describe(
          "Required when type=array. Recursive shape — describes the inner item type. Carries no `name` (see `fieldShape`).",
        )
        .optional(),
      refKind: z
        .string()
        .regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$"))
        .describe(
          "Required when type=ref. The target collection's `name`. Hosts validate that ref values point at items of this collection.",
        )
        .optional(),
      pattern: z
        .string()
        .describe("OPTIONAL regex constraint. Only valid when type=string.")
        .optional(),
      min: z
        .number()
        .describe(
          "OPTIONAL minimum. For type=number: minimum value. For type=array: minimum length.",
        )
        .optional(),
      max: z
        .number()
        .describe(
          "OPTIONAL maximum. For type=number: maximum value. For type=array: maximum length.",
        )
        .optional(),
      format: z
        .string()
        .describe(
          "OPTIONAL named format. Common values: email, uri, semver, uuid, slug. Only valid when type=string. Hosts MAY interpret unknown formats as advisory.",
        )
        .optional(),
      enabled: z
        .boolean()
        .describe(
          "OPTIONAL deprecation flag. A child may set false to mark an inherited field deprecated; the host preserves the field in the resolved schema (so existing items still validate) but flags new uses via lint. Setting enabled:false on a field a child does not inherit is invalid.",
        )
        .default(true),
    })
    .strict()
    .superRefine(requireCompanionKeys)
    .describe(
      "Definition of one field on a collection's item schema (an entry in `fields[]`). Merge-by-name. Type drift between parent and child is HARD refused. Identical to `fieldShape` plus a REQUIRED `name`; keep the two property lists in sync.",
    ),
)

// Hand-written — see fix (3) in the file banner. `collection.item/v1`'s
// `createdAt` / `updatedAt` accept a native `Date` (as produced by
// js-yaml auto-resolving an unquoted ISO-8601 timestamp scalar) in
// addition to a plain string, normalizing to an ISO string either way.
const dateTimeStringSchema = z
  .union([z.string().datetime({ offset: true }), z.date()])
  .transform((v) => (v instanceof Date ? v.toISOString() : v))

export const collectionFrontmatterSchema = z.discriminatedUnion("schema", [
  z.object({ "schema": z.literal("collection.schema/v1").describe("Discriminator for a collection definition."), "name": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).min(2).max(96).describe("Stable kebab-case identifier. Items reference this name via their `collection:` field."), "title": z.string().min(1).max(200).describe("Human-readable collection title."), "description": z.string().min(1).max(2000).describe("One-paragraph statement of purpose: what this collection captures and when an item belongs here vs another collection."), "version": z.string().regex(new RegExp("^[0-9]+\\.[0-9]+\\.[0-9]+(-[A-Za-z0-9.-]+)?$")).describe("Semantic version of the SHAPE. Bump on field/status/lint changes. Independent of the collection's content."), "extends": z.string().regex(new RegExp("^(\\.\\./|\\./)[^\\s]+/COLLECTION\\.md$")).min(1).max(512).describe("OPTIONAL — relative path to a parent COLLECTION.md. Recursive composition; maximum chain depth is 8.").optional(), "appliesTo": z.array(z.string().regex(new RegExp("^(ws://(workspaces|wikis|companies|operators|skills)/[a-z][a-z0-9-]*|\\.\\./[^\\s]+)$")).describe("Either a ws:// ref to an AIP-20 work workspace, AIP-10 wiki, AIP-6 company, AIP-9 operator, or AIP-3 skill — or a relative path to a consumer workspace folder.")).refine((arr) => arr.every((item, i) => arr.indexOf(item) == i), { message: "All items must be unique!" }).describe("OPTIONAL — list of consumers this collection adapts for. Hosts MUST refuse if any binding does not resolve. Not inherited; each child declares its own scope.").optional(), "fields": z.array(fieldDefSchema).describe("Item field schema. Merge-by-name vs parent: a child entry with the same `name` replaces the parent's (subject to type-drift refusal); new names are appended.").default([] as never), "statuses": z.array(z.object({ "id": z.string().regex(new RegExp("^[a-z][a-z0-9-]*$")).describe("Stable kebab-case status id. Merge key when composing."), "label": z.string().min(1).max(60).describe("Human-readable status label."), "terminal": z.boolean().describe("Whether items in this status are considered closed. Lints like `overdue` typically skip terminal statuses.").default(false), "transitionsTo": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*$"))).refine((arr) => arr.every((item, i) => arr.indexOf(item) == i), { message: "All items must be unique!" }).describe("OPTIONAL — allowed next status ids. If omitted, all transitions are permitted.").optional() }).strict()).describe("Status state machine. Merge-by-id vs parent. Children may add statuses, mark inherited statuses terminal, or narrow `transitionsTo`; they MUST NOT remove an inherited status.").default([] as never), "initialStatus": z.string().regex(new RegExp("^[a-z][a-z0-9-]*$")).describe("OPTIONAL — default status assigned to new items. MUST refer to a status declared (locally or inherited) by this collection.").optional(), "ownership": z.object({ "cardinality": z.enum(["none","single","multiple"]).describe("How many owners an item may carry. `none` = no ownership concept; `single` = one owner; `multiple` = list of owners.").default("single"), "role": z.string().regex(new RegExp("^[a-z][a-zA-Z0-9_]*$")).describe("Item field name that holds the owner ref.").default("owner"), "required": z.boolean().describe("Whether items MUST declare an owner.").default(false) }).strict().describe("Ownership rules. Each leaf field overrides independently across the chain.").optional(), "deadline": z.object({ "kind": z.enum(["none","target-date","window","recurrent"]).describe("Deadline shape. `none` = no deadline concept; `target-date` = single date; `window` = start+end; `recurrent` = repeating.").default("none"), "required": z.boolean().describe("Whether items MUST declare a deadline value.").default(false), "fieldName": z.string().regex(new RegExp("^[a-z][a-zA-Z0-9_]*$")).describe("Item field name that holds the deadline value.").default("dueAt") }).strict().describe("Deadline rules. Each leaf field overrides independently.").optional(), "lints": z.array(z.object({ "id": z.string().regex(new RegExp("^[a-z][a-z0-9-]*$")).describe("Stable kebab-case lint id. Merge key when composing."), "kind": z.enum(["missing-owner","overdue","orphan","broken-ref","stale","required-field","custom"]).describe("Lint algorithm. `custom` delegates to a host-defined check identified by `id`."), "appliesTo": z.literal("*").describe("Always '*' — items belong to one collection, so the lint always applies to all items of this collection. The field is preserved for symmetry with AIP-10's lint shape."), "severity": z.enum(["error","warn","info"]).describe("Lint severity. Children may soften; governance policies MAY forbid softening below `error`."), "params": z.record(z.string(), z.any()).describe("Kind-specific parameters. e.g. { days: 30 } for `stale`; { field: 'severity' } for `required-field`.").default({} as never) }).strict()).describe("Lint rules. Merge-by-id vs parent.").default([] as never), "identity": z.object({ "slugSource": z.string().min(1).max(200).describe("How to derive an item's slug. Either a field name (e.g. 'title'), the literal 'random', the literal 'sequence', or 'hash:<comma-separated-source-fields>' (e.g. 'hash:title,createdAt').").optional(), "filingPath": z.string().min(1).max(512).describe("Template for where items are filed on disk. Tokens: {collection}, {slug}, {year}, {month}. e.g. 'items/{collection}/{slug}.md'.").optional() }).strict().describe("Item identity & filing rules.").optional(), "metadata": z.record(z.string(), z.any()).describe("Vendor-specific extensions, namespaced under <vendor>. Deep-merged across the extends chain.").default({} as never) }).strict().describe("Collection schema doctype. Declares the shape of items (fields, statuses, ownership, deadline, lints, identity). Composes via `extends:` against another COLLECTION.md."),
  z.object({ "schema": z.literal("collection.item/v1").describe("Discriminator for an item instance."), "collection": z.any().superRefine((x, ctx) => {
    const schemas = [z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).min(2).max(96).describe("Canonical 99% form — just the collection's name. Host floats to the current resolved schema; drift surfaces as collection_item_schema_drift (warn)."), z.object({ "name": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).min(2).max(96), "version": z.string().describe("Semver range (e.g. \"1.x\", \"^1.2\", \"1.2.0\"). When set, schema bumps outside the range fail with collection_item_schema_pinned_drift (HARD).").optional() }).strict().describe("Object form — pin a specific schema range. Power-user escape hatch for archival snapshots, cross-team publishing, third-party imports.")];
    const { errors, failed } = schemas.reduce<{
      errors: z.core.$ZodIssue[];
      failed: number;
    }>(
      ({ errors, failed }, schema) =>
        ((result) =>
          result.error
            ? {
                errors: [...errors, ...result.error.issues],
                failed: failed + 1,
              }
            : { errors, failed })(
          schema.safeParse(x),
        ),
      { errors: [], failed: 0 },
    );
    const passed = schemas.length - failed;
    if (passed !== 1) {
      ctx.addIssue(errors.length ? {
        path: [],
        code: "invalid_union",
        errors: [errors],
        message: "Invalid input: Should pass single schema. Passed " + passed,
      } : {
        path: [],
        code: "custom",
        errors: [errors],
        message: "Invalid input: Should pass single schema. Passed " + passed,
      });
    }
  }).describe("Reference to the COLLECTION.md this item validates against. Resolution order: inline (workspace root) → local file (<workspace>/collections/<name>/COLLECTION.md) → registry (ws://collections/<name>). Unresolvable → collection_unresolvable (HARD)."), "id": z.string().regex(new RegExp("^[A-Za-z0-9][A-Za-z0-9_:-]*$")).min(1).max(96).describe("Unique identifier within the collection. May be kebab-case, prefixed (BUG-1234), or hashed; the collection's identity.slugSource controls how it's derived for new items."), "title": z.string().min(1).max(200).describe("Human-readable item title."), "parent": z.string().describe("OPTIONAL — containment ref. May target another item or another collection.").optional(), "owner": z.any().superRefine((x, ctx) => {
    const schemas = [z.string(), z.array(z.string()).refine((arr) => arr.every((item, i) => arr.indexOf(item) == i), { message: "All items must be unique!" })];
    const { errors, failed } = schemas.reduce<{
      errors: z.core.$ZodIssue[];
      failed: number;
    }>(
      ({ errors, failed }, schema) =>
        ((result) =>
          result.error
            ? {
                errors: [...errors, ...result.error.issues],
                failed: failed + 1,
              }
            : { errors, failed })(
          schema.safeParse(x),
        ),
      { errors: [], failed: 0 },
    );
    const passed = schemas.length - failed;
    if (passed !== 1) {
      ctx.addIssue(errors.length ? {
        path: [],
        code: "invalid_union",
        errors: [errors],
        message: "Invalid input: Should pass single schema. Passed " + passed,
      } : {
        path: [],
        code: "custom",
        errors: [errors],
        message: "Invalid input: Should pass single schema. Passed " + passed,
      });
    }
  }).describe("OPTIONAL — owner ref(s). Single string or array depending on collection.ownership.cardinality.").optional(), "status": z.string().regex(new RegExp("^[a-z][a-z0-9-]*$")).describe("OPTIONAL — current status. MUST be a status id declared (locally or inherited) by the collection.").optional(), "dueAt": z.string().describe("OPTIONAL — deadline value. Format depends on collection.deadline.kind: ISO date for target-date, ISO datetime for window, RRULE-like for recurrent. Same quoting rule as `createdAt`: producers SHOULD quote date and datetime values; consumers MAY accept a native date/timestamp.").optional(), "attachments": z.array(z.string()).refine((arr) => arr.every((item, i) => arr.indexOf(item) == i), { message: "All items must be unique!" }).describe("OPTIONAL — list of attachment refs. Hosts resolve refs against the workspace's file registry.").default([] as never), "links": z.array(z.string()).refine((arr) => arr.every((item, i) => arr.indexOf(item) == i), { message: "All items must be unique!" }).describe("OPTIONAL — list of cross-references to other items, knowledge entries, or external URLs.").default([] as never), "tags": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*$"))).refine((arr) => arr.every((item, i) => arr.indexOf(item) == i), { message: "All items must be unique!" }).describe("OPTIONAL — free-form tags consumed by retrieval, search, and grouping.").default([] as never), "createdAt": dateTimeStringSchema.describe("OPTIONAL — ISO 8601 creation timestamp. Producers SHOULD write it as a quoted YAML string (createdAt: \"2026-04-26T09:14:00Z\"): some YAML 1.1 parsers resolve an unquoted ISO timestamp to a native timestamp, which is not a string. Consumers MAY accept a native timestamp and normalize it to an ISO 8601 string before validating.").optional(), "updatedAt": dateTimeStringSchema.describe("OPTIONAL — ISO 8601 last-update timestamp. Same quoting rule as `createdAt`: producers SHOULD quote it; consumers MAY accept a native timestamp.").optional(), "metadata": z.record(z.string(), z.any()).describe("Vendor-specific extensions, namespaced under <vendor>. Hosts MUST tolerate unknown keys; the spec's normative fields MUST NOT change meaning.").default({} as never) }).catchall(z.any()).describe("Item instance doctype. Universal core (schema, collection, id, title) is the only set of MUST fields. Every other field shown here is OPTIONAL at the AIP-18 level — the resolved collection schema decides which become required for this collection's items. additionalProperties is true because collection-specific fields (declared in COLLECTION.md fields[]) appear flat at the item's top level."),
]).describe("Validates the YAML frontmatter portion of an AIP-18 collection schema or item. The doctype is selected via the `schema` discriminator: 'collection.schema/v1' (a COLLECTION.md, the schema for a class of records) or 'collection.item/v1' (an instance of one record validated against a named collection).")

export type CollectionFrontmatter = z.infer<typeof collectionFrontmatterSchema>

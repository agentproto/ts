/**
 * AIP-20 WORK.md frontmatter zod schema.
 *
 * Generated from `resources/aip-20/draft/WORK.schema.json` via
 * json-schema-to-zod. Imported by both `define-work.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-work.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const workFrontmatterSchema = z.object({ "schema": z.literal("work.workspace/v2").describe("Discriminator for the AIP-20 work manifest."), "name": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).min(2).max(96).describe("Stable kebab-case identifier of this work root."), "title": z.string().min(1).max(200).describe("Human-readable workspace title."), "description": z.string().min(1).max(2000).describe("One-paragraph statement of what this work root tracks."), "collections": z.array(z.any()).describe("Collections tracked in this root. Every entry MUST resolve to `work-item` or a collection extending it. Two entries with the same effective name (alias, else name) are refused (work_collection_alias_conflict).").default([] as never), "containment": z.object({ "allowedParents": z.record(z.any(), z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*$"))).refine((arr) => arr.every((item, i) => arr.indexOf(item) == i), { message: "All items must be unique!" })).describe("Child collection -> allowed parent collections. Empty list = no parent allowed; absent key = any enabled collection.").optional(), "maxDepth": z.number().int().gte(1).default(5) }).strict().optional(), "statusRollup": z.object({ "enabled": z.boolean().default(false), "rules": z.array(z.object({ "when": z.string().regex(new RegExp("^(all-children-terminal|any-child-waiting|any-child-blocked|any-child-overdue|no-children|custom:[a-z][a-z0-9-]*)$")), "category": z.enum(["todo","active","waiting","done","failed","cancelled"]) }).strict()).describe("Evaluated in order, first match wins. The result is exposed as a derived `rolledCategory`, never stored as status.").optional() }).strict().optional(), "coordination": z.object({ "leaseTtlSeconds": z.number().int().gte(0).describe("0 = liveness-only leases released by the issuing host; >0 = any coordinator may release a lease not renewed for this long.").default(0), "lockStaleSeconds": z.number().int().gte(1).describe("Age after which a lock file may be broken.").default(30) }).strict().optional(), "lints": z.array(z.object({ "id": z.string().regex(new RegExp("^[a-z][a-z0-9-]*$")), "kind": z.enum(["orphan","stale","broken-ref","dangling-dependency","custom"]), "severity": z.enum(["error","warn","info"]), "params": z.record(z.string(), z.any()).optional() }).strict()).default([] as never), "defaults": z.object({ "workflow": z.string().min(1).describe("OPTIONAL AIP-15 routine workflow for this root.").optional(), "auditMutations": z.boolean().describe("Append an AIP-7 audit-event per applied write. false is allowed only for scratch roots.").default(true) }).strict().optional(), "views": z.array(z.object({ "id": z.string().regex(new RegExp("^[a-z][a-z0-9-]*$")), "title": z.string().min(1).max(120), "filter": z.object({ "collection": z.union([z.string(), z.array(z.string())]).optional(), "status": z.union([z.string(), z.array(z.string())]).optional(), "category": z.any().superRefine((x, ctx) => {
    const schemas = [z.enum(["todo","active","waiting","done","failed","cancelled"]), z.array(z.enum(["todo","active","waiting","done","failed","cancelled"]))];
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
  }).optional(), "owner": z.string().optional(), "parent": z.string().optional(), "blocked": z.boolean().optional(), "includeClosed": z.boolean().default(false) }).strict().optional(), "groupBy": z.enum(["category","status","owner","parent","collection"]).optional(), "layout": z.enum(["list","board","tree","timeline"]).default("list") }).strict()).describe("Saved queries. The first is the default view.").default([] as never), "executor": z.string().regex(new RegExp("^ws://operators/[a-z][a-z0-9-]*$")).describe("OPTIONAL — AIP-9 default executor operator. The host activates this operator when an item with no explicit assignee surfaces.").optional(), "governance": z.string().min(1).max(512).describe("OPTIONAL — AIP-7 policy or audit binding. May be a path to an AIP-7 policy file or a ws:// ref. Status-transition approvals, owner-change audits, and scope-widening interventions flow through this ref.").optional(), "knowledge": z.string().regex(new RegExp("^ws://wikis/[a-z][a-z0-9-]*(/KNOWLEDGE\\.md)?$")).describe("OPTIONAL — AIP-10 KNOWLEDGE.md ref. Lets cross-references on items resolve against the bound wiki by default.").optional(), "metadata": z.record(z.string(), z.any()).describe("Vendor-specific extensions, namespaced under <vendor>. Deep-merged across the extends chain. MUST NOT change the meaning of any spec field.").default({} as never) }).strict().and(z.any().describe("A view (any manifest with appliesTo set) MUST extend a parent. A workspace-root manifest has neither field.")).describe("Validates the YAML frontmatter of an AIP-20 WORK.md — the work manifest of one AIP-34 workspace node (or a coordinator scratch root). There is no view mode: `extends` and `appliesTo` are not allowed. Item schemas are AIP-18 collections extending the normative `work-item` base collection.")

export type WorkFrontmatter = z.infer<typeof workFrontmatterSchema>

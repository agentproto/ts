/**
 * AIP-35 STORAGE.md frontmatter zod schema.
 *
 * Generated from `resources/aip-35/draft/STORAGE.schema.json` via
 * json-schema-to-zod. Imported by both `define-storage.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-storage.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const storageFrontmatterSchema = z.object({ "schema": z.literal("storage/v1").describe("Standalone-only. Identifies the doctype + version. Absent when the block is inlined in another manifest.").optional(), "id": z.string().regex(new RegExp("^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$")).describe("Standalone-only. Globally addressable id `@<owner-slug>/<storage-slug>`.").optional(), "version": z.string().regex(new RegExp("^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.\\-]+)?$")).describe("Standalone-only. Spec version of THIS file. Bump on breaking shape change.").optional(), "provider": z.string().min(1).describe("Backend kind. Day-1 enumerated set: cloud-bucket | self-bucket | github | local-fs | dev-local | mastra-s3 | mastra-azure. Hosts MAY register additional ids; the schema accepts any non-empty string and host-side validation narrows."), "config": z.record(z.string(), z.any()).describe("Provider-specific connection fields. Shape varies per provider (see AIP-35 §Provider config shapes)."), "sync": z.any().describe("Sync semantics. Lifecycle triggers reference AIP-37 event names.").optional(), "auth": z.any().describe("Reference to AIP-19 SECRETS.md (or future ENV.md) for credentials.").optional(), "identity": z.any().describe("AIP-23 identity-ref block — commit author(s) for syncing providers (github). Supports multi-attribution (primary + co-authors).").optional(), "exclude": z.array(z.string()).describe("Paths NOT mirrored to the backing store. Glob-ish, prefix-matched.").default([] as never), "read_only": z.boolean().describe("Reject writes at the storage layer.").default(false), "metadata": z.record(z.string(), z.any()).describe("Free-form, namespaced. Authors MAY stash adapter-specific hints under namespaced keys.").optional() }).strict().describe("Validates the YAML frontmatter portion of an AIP-35 STORAGE.md manifest, OR the inline form embedded in any other manifest's `storage:` block. Filesystem-only — sandbox-shaped backends (e2b/modal/...) live in AIP-36 SANDBOX.md.")

export type StorageFrontmatter = z.infer<typeof storageFrontmatterSchema>

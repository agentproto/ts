/**
 * AIP-36 SANDBOX.md frontmatter zod schema.
 *
 * Generated from `resources/aip-36/draft/SANDBOX.schema.json` via
 * json-schema-to-zod. Imported by both `define-sandbox.ts` (TS path
 * validation) and `manifest/index.ts` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in `define-sandbox.ts`'s `validate(def)` instead.
 */

import { z } from "zod"

export const sandboxFrontmatterSchema = z.object({ "schema": z.literal("sandbox/v1").describe("Standalone-only. Identifies the doctype + version. Absent when the block is inlined.").optional(), "id": z.string().regex(new RegExp("^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$")).describe("Standalone-only. Globally addressable id `@<owner-slug>/<sandbox-slug>`.").optional(), "version": z.string().regex(new RegExp("^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.\\-]+)?$")).describe("Standalone-only. Spec version of THIS file.").optional(), "provider": z.string().min(1).describe("Backend kind. Day-1 enumerated set: local | mastra-e2b | mastra-modal | mastra-daytona | mastra-blaxel | node-permission. Hosts MAY register additional ids."), "config": z.record(z.string(), z.any()).describe("Provider-specific connection fields. Shape varies per provider (see AIP-36 §Provider config shapes)."), "limits": z.object({ "timeout_ms": z.number().int().gte(1).optional(), "memory_mb": z.number().int().gte(1).optional(), "cpu_ms": z.number().int().gte(1).optional() }).strict().describe("Resource caps per command.").optional(), "env": z.object({ "auth": z.any().optional(), "passthrough": z.array(z.string()).describe("Static host env-var names to forward into the sandbox.").default([] as never) }).strict().optional(), "network": z.object({ "egress": z.array(z.string()).describe("Hostnames the sandbox MAY reach. Empty / missing = no egress.").default([] as never) }).strict().optional(), "mounts": z.array(z.any()).describe("Filesystems mounted inside the sandbox at declared paths. Maps to Mastra Workspace.mounts.").default([] as never), "identity": z.any().describe("AIP-23 identity-ref — owner of the sandbox processes.").optional(), "lifecycle": z.object({ "pause_after_idle": z.string().min(1).describe("AIP-37 event name (e.g. `idle-600` for 10 min). Provider-supported only (modal, daytona).").optional(), "destroy_on": z.string().min(1).describe("AIP-37 event name (e.g. `workspace-close`).").optional() }).strict().optional(), "read_only": z.boolean().describe("Reject command execution at the sandbox layer. Read-only sandbox calls fail with `sandbox_read_only`.").default(false), "extraPorts": z.array(z.number().int().gte(1)).describe("App ports to expose at boot time. Resolved into BootedSandbox.ports (port → public URL) by providers that support port exposure.").optional(), "metadata": z.record(z.string(), z.any()).describe("Free-form, namespaced. Adapter hints under `metadata.<adapter>.*`.").optional() }).strict().describe("Validates the YAML frontmatter portion of an AIP-36 SANDBOX.md manifest, OR the inline form embedded in any other manifest's `sandbox:` block. Compute-only — durable filesystem backings live in AIP-35 STORAGE.md.")

export type SandboxFrontmatter = z.infer<typeof sandboxFrontmatterSchema>

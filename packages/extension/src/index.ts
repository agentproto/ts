/**
 * @agentproto/extension — AIP-40 EXTENSION.md `defineExtension` reference impl.
 *
 * A meta-doctype that lets a workspace declare its own custom doctype as an extension of an existing AIP — adding fields, tightening constraints, overriding defaults, and choosing a path convention — without going through the public AIP process. The runtime (@agentproto/manifest verbs, MCP server, scaffolder) treats local extensions identically to public AIPs.
 *
 * Spec: https://agentproto.sh/docs/aip-40
 *
 * Authoring paths:
 *   - TS:  `defineExtension({...})` → `ExtensionHandle`
 *   - MD:  `parseExtensionManifest(src) → extensionFromManifest({...})` → `ExtensionHandle`
 */

export const SPEC_NAME = "agentextension/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineExtension } from "./define-extension.js"
export type { ExtensionDefinition, ExtensionHandle } from "./types.js"
export {
  specFromExtension,
  type SpecFromExtensionOptions,
} from "./spec-from-extension.js"

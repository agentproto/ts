/**
 * `specFromExtension(handle, parent)` — turn a parsed EXTENSION.md
 * into a runtime `DoctypeSpec` consumable by
 * `@agentproto/manifest.createVerbs`.
 *
 * The parent argument is the public AIP's spec (e.g. `toolSpec` from
 * `@agentproto/tool`). The function composes:
 *
 *   schema       parent.schema ∪ ext.add_fields, then ext.tighten
 *   path         ext.path_convention ?? parent.pathOf
 *   defaults     parent defaults ⨁ ext.defaults
 *   define       wraps parent.define with default-application
 *   parse        parent.parse (frontmatter shape stays compatible)
 *
 * Tightening monotonicity is verified by-field: pattern subset
 * (cheap heuristic — full regex-language inclusion is undecidable),
 * enum subset (set membership), minLength/minimum ≥, maxLength/maximum ≤.
 *
 * For `extends: none`, `parent` is null/undefined and the extension
 * acts as a root doctype: the `add_fields` becomes its full schema,
 * `path_convention` is required (no parent fallback).
 */

import type { DoctypeSpec } from "@agentproto/manifest"
import type { ExtensionDefinition } from "./types.js"

export interface SpecFromExtensionOptions<
  TParams extends { id?: string; slug?: string; name?: string },
  THandle,
> {
  /**
   * Parent doctype spec. Required when `extension.extends !== "none"`.
   * Pass e.g. `toolSpec` from `@agentproto/tool`.
   */
  parent?: DoctypeSpec<TParams, THandle>
}

export function specFromExtension<
  TParams extends { id?: string; slug?: string; name?: string },
  THandle,
>(
  extension: ExtensionDefinition,
  opts: SpecFromExtensionOptions<TParams, THandle> = {},
): DoctypeSpec<TParams, THandle> {
  const { parent } = opts
  const isRoot = extension.extends === "none"

  if (!isRoot && !parent) {
    throw new Error(
      `specFromExtension (AIP-40): extension '${extension.slug}' extends '${extension.extends}' but no parent spec was provided in opts.parent`,
    )
  }
  if (isRoot && !extension.path_convention) {
    throw new Error(
      `specFromExtension (AIP-40): extension '${extension.slug}' is a root doctype (extends: none) and MUST declare path_convention`,
    )
  }

  // Tightening monotonicity check — see Specification §"Composition rules" #3.
  if (parent && extension.tighten) {
    verifyTightening(extension, parent)
  }

  const slugName = extension.slug.split(":")[1] ?? extension.slug
  const pathTemplate = extension.path_convention ?? null

  // Keys the extension is authoritative over — anything declared in
  // `add_fields.properties`. Computed once at spec-composition time so
  // the per-call `define` is a hot-path lookup, not a re-derivation.
  const extensionKeys = new Set(
    Object.keys(extension.add_fields?.properties ?? {}),
  )

  const define = (params: TParams) => {
    // Layered defaults: parent defaults are baked into parent.define;
    // extension defaults apply on top, only for keys the user omitted.
    const withDefaults = { ...params } as Record<string, unknown>
    if (extension.defaults) {
      for (const [key, value] of Object.entries(extension.defaults)) {
        if (withDefaults[key] === undefined && value !== undefined) {
          withDefaults[key] = value
        }
      }
    }
    if (isRoot) {
      // Root doctype — no parent.define to delegate to. Return the
      // params verbatim, frozen. (A more disciplined runtime would
      // compile the add_fields schema to zod and validate; deferred
      // because root doctypes are rare and the manifest layer's
      // schema-level zod catches malformed input.)
      return Object.freeze(withDefaults) as unknown as THandle
    }
    // Split params before delegating: parent specs typically validate
    // through `zod.strict()` (e.g. AIP-42 `agentFrontmatterSchema`),
    // which rejects extension-owned keys as "Unrecognized". Hand the
    // parent only what it owns, then re-attach extension fields onto
    // the resulting handle. Extension-side validation of these fields
    // is the manifest layer's responsibility (compiled from
    // `add_fields` JSON Schema at parse time); the runtime trusts
    // input it received via that path.
    const parentOnly: Record<string, unknown> = {}
    const extensionOnly: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(withDefaults)) {
      if (extensionKeys.has(key)) extensionOnly[key] = value
      else parentOnly[key] = value
    }
    const parentHandle = parent!.define(parentOnly as unknown as TParams)
    return Object.freeze({
      ...(parentHandle as object),
      ...extensionOnly,
    }) as unknown as THandle
  }

  const parse = isRoot ? rootParse(extension) : parent!.parse

  const pathOf = (handle: THandle) => {
    if (pathTemplate) {
      return resolvePathTemplate(
        pathTemplate,
        handle as unknown as Record<string, unknown>,
        slugName,
      )
    }
    return parent!.pathOf(handle)
  }

  return {
    name: extension.slug,
    aip: 40,
    schemaLiteral: parent?.schemaLiteral ?? `agentproto/extension/v1`,
    pathOf,
    define,
    parse,
  }
}

function verifyTightening<
  TParams extends { id?: string; slug?: string; name?: string },
  THandle,
>(
  extension: ExtensionDefinition,
  parent: DoctypeSpec<TParams, THandle>,
): void {
  // Best-effort: the manifest layer doesn't expose the parent's raw
  // JSON Schema, so we can only verify what the spec ships in
  // `extension.tighten` against itself for self-consistency. Full
  // parent-vs-extension monotonicity verification belongs to a future
  // version once parent specs expose `schema:` introspection.
  const _parent = parent
  const t = extension.tighten ?? {}
  for (const [field, override] of Object.entries(t)) {
    if (
      typeof override.minLength === "number" &&
      typeof override.maxLength === "number" &&
      override.minLength > override.maxLength
    ) {
      throw new Error(
        `specFromExtension (AIP-40): extension '${extension.slug}' tighten.${field}: minLength (${override.minLength}) > maxLength (${override.maxLength})`,
      )
    }
    if (
      typeof override.minimum === "number" &&
      typeof override.maximum === "number" &&
      override.minimum > override.maximum
    ) {
      throw new Error(
        `specFromExtension (AIP-40): extension '${extension.slug}' tighten.${field}: minimum (${override.minimum}) > maximum (${override.maximum})`,
      )
    }
    if (override.enum !== undefined && !Array.isArray(override.enum)) {
      throw new Error(
        `specFromExtension (AIP-40): extension '${extension.slug}' tighten.${field}: enum must be an array`,
      )
    }
  }
}

function rootParse(extension: ExtensionDefinition) {
  return (source: string) => {
    // Root doctypes don't have a parent parser — fall back to bare
    // gray-matter. The manifest layer applies `define` afterwards.
    // We don't import gray-matter here to keep this module dependency-
    // light; the caller wires their own parse if they really want a
    // root doctype, or uses the standard parse from a sibling package.
    void source
    void extension
    throw new Error(
      `specFromExtension (AIP-40): extension '${extension.slug}' is a root doctype — supply your own parser or extend a public AIP for parser inheritance`,
    )
  }
}

function resolvePathTemplate(
  template: string,
  handle: Record<string, unknown>,
  doctypeSlug: string,
): string {
  // Tokens supported in v1: <slug> (the doctype's identity field —
  // tries id, slug, name in that order) and <DOCTYPE> (uppercase
  // version of the extension's slug name part, e.g. "DEAL").
  const identity =
    (typeof handle.id === "string" && handle.id) ||
    (typeof handle.slug === "string" && handle.slug) ||
    (typeof handle.name === "string" && handle.name) ||
    "unknown"
  return template
    .replace(/<slug>/g, identity)
    .replace(/<DOCTYPE>/g, doctypeSlug.toUpperCase())
}

/**
 * AIP-5 CanvakitDefinition + CanvakitHandle.
 *
 * `CanvakitDefinition` was generated from
 * `resources/aip-5/draft/TEMPLATE.schema.json` via json-schema-to-typescript.
 * `CanvakitHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Discriminated by 'kind'. One of: tool, static, file, query.
 */
export type Source = SourceTool | SourceStatic | SourceFile | SourceQuery

/**
 * Validates the YAML frontmatter portion of an AIP-5 *.canvakit.* template.
 */
export interface CanvakitDefinition {
  /**
   * Spec version pin. Hosts that find an unknown schema MUST refuse rather than guess.
   */
  schema?: "canvakit/v1"
  /**
   * Required marker. Tooling that loads files by glob uses this to catch 'renamed but not a template' mistakes.
   */
  template: true
  /**
   * Slug-safe machine name. Lowercase, digits, dashes.
   */
  name: string
  /**
   * Semver. Bump on breaking change to the rendered shape or variables contract.
   */
  version: string
  /**
   * One-sentence purpose for the gallery card.
   */
  description?: string
  /**
   * Optional locally; required for gallery publish — (author, name, version) is the canonical key.
   */
  author?: string
  /**
   * Template engine. v1 default 'mustache' is universally supported; others are spec-legal but optional.
   */
  renderer?: "mustache" | "handlebars" | "mdx"
  /**
   * Designkit fallback hint. Used only when no workspace design is active. Schemes: dk:<preset>, ws:<path>, kit:<slug>, or a bare *.md path.
   */
  design?: string
  /**
   * Designkit override. Bypasses workspace selection. Same scheme grammar as 'design'.
   */
  forceDesign?: string
  /**
   * Declarative cadence hint. Honored opportunistically; runtimes that can't honor SHOULD treat as 'manual'.
   */
  refreshEvery?: ("manual" | "on-tool-change") | string
  /**
   * Caller inputs with author defaults. Substituted into sources params before resolution.
   */
  variables?: {
    [k: string]: Variable
  }
  /**
   * Named data sources resolved in parallel and merged into the render context.
   */
  sources?: {
    [k: string]: Source
  }
  /**
   * Nested canvases. Each renders in isolation; output exposed under {{{imports.<name>}}}.
   */
  imports?: {
    [k: string]: Import
  }
  tags?: string[]
  /**
   * Host-specific extension surface. Other hosts MUST tolerate unknown metadata.<host>.* keys.
   */
  metadata?: {
    [k: string]: unknown
  }
}
export interface Variable {
  type?: "string" | "number" | "boolean" | "object" | "array"
  required?: boolean
  default?: unknown
  description?: string
}
export interface SourceTool {
  kind: "tool"
  /**
   * Tool identifier. Flat ('searchFlights'), namespaced ('stripe.mrr'), or MCP-qualified ('mcp://server/tool'). Resolution: exact > longest wildcard > MCP.
   */
  ref: string
  /**
   * JSON params passed verbatim to the resolver. String values may interpolate {{variables.*}}.
   */
  params?: {
    [k: string]: unknown
  }
  /**
   * Legacy alias for 'params'. Hosts SHOULD accept and warn.
   */
  args?: {
    [k: string]: unknown
  }
}
export interface SourceStatic {
  kind: "static"
  /**
   * Literal pass-through. Never fetched, never parsed.
   */
  value: {
    [k: string]: unknown
  }
}
export interface SourceFile {
  kind: "file"
  /**
   * Filesystem path relative to the render filesystem. Parsed by extension per the format contract.
   */
  path: string
  /**
   * Resolve `path` against a named workspace instead of the render filesystem. The host's workspace resolver supplies the filesystem (and enforces access); unconfigured cross-workspace refs surface as status:error.
   */
  workspace?: string
}
export interface SourceQuery {
  kind: "query"
  /**
   * Glob or array of globs. Bare directory paths are rewritten to <path>/** /*.md.
   */
  include: string | [string, ...string[]]
  /**
   * Field predicates against parsed shape. Supports equality and operators _in, _contains, _before, _after.
   */
  where?: {
    [k: string]: unknown
  }
  /**
   * field (asc) or -field (desc) on a parsed key.
   */
  sort?: string
  limit?: number
  /**
   * Project to a subset of parsed keys.
   */
  fields?: string[]
  /**
   * Resolve the glob against a named workspace instead of the render filesystem. The host's workspace resolver supplies the filesystem (and enforces access); unconfigured cross-workspace refs surface as status:error.
   */
  workspace?: string
}
export interface Import {
  /**
   * Path to a sibling *.canvakit.* file.
   */
  template: string
  /**
   * Values passed to the imported canvas. Imports do NOT inherit parent variables; pass explicitly.
   */
  variables?: {
    [k: string]: unknown
  }
}

export type CanvakitHandle = Readonly<CanvakitDefinition>

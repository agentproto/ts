/**
 * AIP-52 PackDefinition + PackHandle.
 *
 * A pack is the distributable bundle: a plugin (inline skills or a merge
 * of published skill packs), zero or more apps, a knowledge workspace
 * selection, and an optional playbook to generate — plus pricing and
 * non-technical blockers.
 *
 * `PackHandle` is the readonly view with a derived `status` computed in
 * `define-pack.ts`'s `build()`.
 */

/**
 * AIP-52 PACK.md bundle: plugin + apps + knowledge + playbook.
 */
export type PackDefinition = {
  schema: "pack/v1"
  /**
   * Kebab-case pack id — matches the directory name.
   */
  name: string
  /**
   * Human-readable title, e.g. "The Agentic Coder".
   */
  title: string
  description: string
  /**
   * Semantic version of the pack.
   */
  version: string

  plugin: {
    /**
     * Build the plugin from `./skills/` (self-contained).
     */
    inline?: boolean
    /**
     * Published packs to merge (`@agentproto/skill-pack-*`).
     */
    includes?: string[]
  }

  apps?: Array<{
    id: string
    /**
     * Path to the app, relative to the pack root.
     */
    path: string
  }>

  knowledge?: {
    /**
     * Knowledge workspace name.
     */
    workspace: string
    /**
     * Tag OR filter.
     */
    anyOf?: string[]
    /**
     * Tag AND filter.
     */
    allOf?: string[]
    /**
     * Entry kind filter.
     */
    kinds?: string[]
  }

  playbook?: {
    title: string
    /**
     * Book-factory root path.
     */
    root?: string
    targetChapters?: number
  }

  pricing?: {
    ebook?: number
    bundle: number
    step?: number
  }

  /**
   * Non-technical blockers → forces `gated` status.
   */
  blockers?: string[]
}

/**
 * Derived lifecycle state of a pack.
 */
export type PackStatus = "planned" | "assembling" | "ready" | "gated"

export type PackHandle = Readonly<PackDefinition> & {
  /**
   * Derived from `blockers` + plugin resolution in `definePack`'s build().
   */
  readonly status: PackStatus
}
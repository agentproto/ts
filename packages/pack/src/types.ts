/**
 * PackDefinition + PackHandle (unassigned AIP — no spec written yet).
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
 * A catalog member entry: the member's file, relative to the pack root.
 */
export type PackCatalogMemberRef = {
  path: string
}

/**
 * PACK.md bundle: plugin + apps + catalog members + knowledge + playbook.
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

  /**
   * AIP-47 role members, each a `ROLE.md` relative to the pack root. The
   * identity (`name`) comes from the file, never from the manifest.
   */
  roles?: PackCatalogMemberRef[]

  /**
   * AIP-25 persona members, each a `PERSONA.md`. Identity is the file's `name`.
   */
  personas?: PackCatalogMemberRef[]

  /**
   * AIP-38 policy members, each a `POLICY.md`. Identity is the file's `id`,
   * so a listed policy MUST declare one.
   */
  policies?: PackCatalogMemberRef[]

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
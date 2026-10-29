/**
 * AIP-47 / AIP-64 installed-pack role source.
 *
 * An installed pack's `roles` members are a catalog source for the node the
 * pack was installed on. This source adapts any such catalog (structurally:
 * `@agentproto/pack`'s `InstalledCatalog` fits) to the `RoleSource` seam, so
 * it can be handed to `resolveRole` and to an operator resolver's injected
 * role loader. It lives here and not in `@agentproto/pack` so this package
 * never depends on packs.
 *
 * Refs answered: `ws://roles/<name>`, `role:<name>` and the bare `<name>`.
 * A ref that names no installed member returns `null`, so the resolver moves
 * on; when no source answers it throws `RoleUnresolvableError`. This source
 * adds no fallback and no default.
 */

import type { RoleManifestRaw, RoleRef, RoleSource } from "./types.js"

export interface InstalledRoleMember {
  /** The role `name`, taken from the member's own ROLE.md. */
  readonly id: string
  /** Name of the installed pack that provides it. */
  readonly pack: string
  /** Parsed, schema-validated frontmatter of the member's ROLE.md. */
  readonly frontmatter: unknown
  /** Markdown body of the member's ROLE.md, verbatim. */
  readonly body: string
}

/** The slice of an installed-pack catalog this source reads. */
export interface InstalledRoleCatalog {
  get(
    kind: "roles",
    ref: string,
    nodeChain?: readonly string[],
  ): InstalledRoleMember | undefined
  list(kind: "roles", nodeChain?: readonly string[]): readonly InstalledRoleMember[]
}

export class InstalledRoleSource implements RoleSource {
  readonly scheme = "pack"

  /**
   * @param nodeChain the AIP-34 node chain this source answers for, nearest
   * node first. Absent: only packs installed without an attach point (the
   * tenant's) resolve.
   */
  constructor(
    private readonly catalog: InstalledRoleCatalog,
    private readonly nodeChain?: readonly string[],
  ) {}

  /** The same catalog, scoped to the node chain of one resolution. */
  forNode(nodeChain: readonly string[]): InstalledRoleSource {
    return new InstalledRoleSource(this.catalog, nodeChain)
  }

  async load(ref: RoleRef): Promise<RoleManifestRaw | null> {
    const member = this.catalog.get("roles", ref, this.nodeChain)
    if (!member) return null
    return {
      ref: `ws://roles/${member.id}`,
      frontmatter: member.frontmatter,
      body: member.body,
      scheme: this.scheme,
    }
  }

  async list(): Promise<readonly RoleRef[]> {
    return this.catalog
      .list("roles", this.nodeChain)
      .map((m) => `ws://roles/${m.id}`)
  }
}

/**
 * AIP-47 §Role sources within a company tree: the nodes' own sources are
 * searched nearest first, and the host's catalog sources (installed packs
 * among them) come after the tree, so a more local role always wins over a
 * pack's role of the same name.
 */
export function roleSourceChain(
  nodeSources: readonly RoleSource[],
  catalogSources: readonly RoleSource[],
): readonly RoleSource[] {
  return [...nodeSources, ...catalogSources]
}

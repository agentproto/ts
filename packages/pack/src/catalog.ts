/**
 * AIP-64 catalog members: reading a pack's roles, personas and policies, and
 * registering them as installed-pack sources.
 *
 * Two halves, matching the spec's install rules:
 *   - `readPackCatalog(root)` reads and validates EVERY declared member
 *     against its owning AIP before anything is registered (rule 1). It only
 *     opens files the manifest declares: a COMPANY.md, OFFICE.md or
 *     OPERATOR.md under the pack root is never read (instances are never pack
 *     content).
 *   - `InstalledCatalog` registers a validated catalog (rule 2), refuses an
 *     identity another pack or a host builtin already provides (rule 3),
 *     scopes it to the node it is attached to (rule 5), and answers a ref
 *     that names no member with `undefined`, adding no fallback (rule 6).
 *     Rule 4 (never shadow a more local source) is the source order of the
 *     consumer: see `roleSourceChain` in `@agentproto/role`.
 *
 * Registering binds nothing: no operator is hired, no persona assigned, no
 * policy applied.
 */

import { readFile, realpath } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { parsePersonaManifest } from "@agentproto/persona/manifest"
import { parsePolicyManifest } from "@agentproto/policy/manifest"
import { parseRoleManifest } from "@agentproto/role/manifest"
import { packFromManifest, parsePackManifest } from "./manifest/index.js"
import { CATALOG_MEMBER_KINDS, type CatalogMemberKind } from "./schema.js"
import type { PackStatus } from "./types.js"

export type { CatalogMemberKind }

/** One validated catalog member of a pack. */
export interface CatalogMember {
  readonly kind: CatalogMemberKind
  /** `name` for a role or persona, `id` for a policy, from the member's own file. */
  readonly id: string
  /** Name of the pack that provides it. */
  readonly pack: string
  /** The path as the manifest declares it. */
  readonly path: string
  /** Parsed, schema-validated frontmatter of the member's file. */
  readonly frontmatter: unknown
  /** Markdown body of the member's file, verbatim. */
  readonly body: string
}

/** A pack whose catalog members have all been read and validated. */
export interface PackCatalog {
  readonly pack: string
  readonly version: string
  readonly status: PackStatus
  readonly blockers: readonly string[]
  readonly members: readonly CatalogMember[]
}

/** A catalog member failed its owning AIP's validation (install rule 1). */
export class PackCatalogInvalidError extends Error {
  readonly code = "pack_member_invalid" as const

  constructor(
    readonly pack: string,
    /** The declared path of the offending member. */
    readonly member: string,
    reason: string,
  ) {
    super(`pack '${pack}': catalog member '${member}' is invalid: ${reason}`)
    this.name = "PackCatalogInvalidError"
  }
}

/** A member identity is already provided by another source (install rule 3). */
export class PackCatalogConflictError extends Error {
  readonly code = "pack_member_conflict" as const

  constructor(
    readonly kind: CatalogMemberKind,
    readonly id: string,
    /** The source that already provides the identity: a pack name or a host catalog label. */
    readonly existing: string,
    /** The pack being installed. */
    readonly incoming: string,
  ) {
    super(
      `pack '${incoming}' cannot install ${kind} '${id}': already provided by '${existing}'`,
    )
    this.name = "PackCatalogConflictError"
  }
}

/** A gated pack is not installable; its blockers are surfaced verbatim. */
export class PackGatedError extends Error {
  readonly code = "pack_gated" as const

  constructor(
    readonly pack: string,
    readonly blockers: readonly string[],
  ) {
    super(`pack '${pack}' is gated and was not installed: ${blockers.join("; ")}`)
    this.name = "PackGatedError"
  }
}

const parsers: Record<
  CatalogMemberKind,
  (source: string) => { frontmatter: unknown; body: string }
> = {
  roles: parseRoleManifest,
  personas: parsePersonaManifest,
  policies: parsePolicyManifest,
}

function identityOf(kind: CatalogMemberKind, frontmatter: unknown): string | undefined {
  const fm = frontmatter as { name?: string; id?: string }
  return kind === "policies" ? fm.id : fm.name
}

/**
 * Read a pack root's PACK.md and every catalog member it declares. Throws
 * `PackCatalogInvalidError` naming the first invalid member, or the manifest
 * parse error; nothing is registered by reading.
 */
export async function readPackCatalog(root: string): Promise<PackCatalog> {
  const manifest = parsePackManifest(await readFile(join(root, "PACK.md"), "utf8"))
  const handle = packFromManifest(manifest)
  const pack = handle.name
  const realRoot = await realpath(root)

  const members: CatalogMember[] = []
  const claimed = new Map<string, string>()
  for (const kind of CATALOG_MEMBER_KINDS) {
    for (const entry of manifest.frontmatter[kind] ?? []) {
      const file = resolve(realRoot, entry.path)
      let source: string
      try {
        const real = await realpath(file)
        if (real !== realRoot && !real.startsWith(realRoot + sep)) {
          throw new Error("resolves outside the pack root")
        }
        source = await readFile(real, "utf8")
      } catch (e) {
        throw new PackCatalogInvalidError(pack, entry.path, `cannot be read (${(e as Error).message})`)
      }

      let parsed: { frontmatter: unknown; body: string }
      try {
        parsed = parsers[kind](source)
      } catch (e) {
        throw new PackCatalogInvalidError(pack, entry.path, (e as Error).message)
      }

      const id = identityOf(kind, parsed.frontmatter)
      if (!id) {
        throw new PackCatalogInvalidError(
          pack,
          entry.path,
          kind === "policies"
            ? "a policy listed in a pack MUST declare an id"
            : "declares no name",
        )
      }
      const key = `${kind}\u0000${id}`
      const prior = claimed.get(key)
      if (prior !== undefined) {
        throw new PackCatalogInvalidError(
          pack,
          entry.path,
          `${kind} identity '${id}' is already declared by '${prior}' in the same pack`,
        )
      }
      claimed.set(key, entry.path)
      members.push(
        Object.freeze({
          kind,
          id,
          pack,
          path: entry.path,
          frontmatter: parsed.frontmatter,
          body: parsed.body,
        }),
      )
    }
  }

  return Object.freeze({
    pack,
    version: handle.version,
    status: handle.status,
    blockers: handle.blockers ?? [],
    members: Object.freeze(members),
  })
}

const REF_PREFIXES: Record<CatalogMemberKind, readonly string[]> = {
  roles: ["ws://roles/", "role:"],
  personas: ["ws://personas/", "persona:"],
  policies: ["ws://policies/", "policy:"],
}

function idFromRef(kind: CatalogMemberKind, ref: string): string {
  for (const prefix of REF_PREFIXES[kind]) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length)
  }
  return ref
}

export interface InstalledCatalogOptions {
  /**
   * Host builtin catalogs the installed packs must not collide with. Return
   * the label of the source that already provides `(kind, id)`, else
   * `undefined`.
   */
  readonly reserved?: (kind: CatalogMemberKind, id: string) => string | undefined
}

export interface InstallOptions {
  /**
   * The AIP-34 node the pack is attached to (its `agentproto.lock` `attach`).
   * Absent: the pack is a source for the whole installing tenant.
   */
  readonly attach?: string
}

interface Installed {
  readonly member: CatalogMember
  readonly attach: string | undefined
}

/**
 * The installed-pack catalog sources of one tenant. A host keeps one
 * instance per tenant, so resolution never crosses a tenant.
 */
export class InstalledCatalog {
  private readonly byKind: Record<CatalogMemberKind, Map<string, Installed>> = {
    roles: new Map(),
    personas: new Map(),
    policies: new Map(),
  }

  constructor(private readonly options: InstalledCatalogOptions = {}) {}

  /**
   * Register a validated catalog. Refuses with `PackGatedError` for a gated
   * pack and `PackCatalogConflictError` for an identity another pack or a
   * host builtin provides; either way nothing is registered. Re-installing a
   * pack of the same name replaces its members.
   */
  install(catalog: PackCatalog, options: InstallOptions = {}): void {
    if (catalog.status === "gated") throw new PackGatedError(catalog.pack, catalog.blockers)

    for (const member of catalog.members) {
      const held = this.byKind[member.kind].get(member.id)
      if (held && held.member.pack !== catalog.pack) {
        throw new PackCatalogConflictError(member.kind, member.id, held.member.pack, catalog.pack)
      }
      const reserved = this.options.reserved?.(member.kind, member.id)
      if (reserved !== undefined) {
        throw new PackCatalogConflictError(member.kind, member.id, reserved, catalog.pack)
      }
    }

    for (const kind of CATALOG_MEMBER_KINDS) {
      for (const [id, held] of this.byKind[kind]) {
        if (held.member.pack === catalog.pack) this.byKind[kind].delete(id)
      }
    }
    for (const member of catalog.members) {
      this.byKind[member.kind].set(member.id, { member, attach: options.attach })
    }
  }

  /**
   * The member a ref names, if one is installed and visible from `nodeChain`
   * (the resolving node and its ancestors). A pack attached to a node is
   * visible only when that node is in the chain; a pack installed without an
   * attach point is visible to all. Absent: no fallback, no default.
   */
  get(
    kind: CatalogMemberKind,
    ref: string,
    nodeChain?: readonly string[],
  ): CatalogMember | undefined {
    const held = this.byKind[kind].get(idFromRef(kind, ref))
    if (!held || !this.visible(held, nodeChain)) return undefined
    return held.member
  }

  list(kind: CatalogMemberKind, nodeChain?: readonly string[]): readonly CatalogMember[] {
    return [...this.byKind[kind].values()]
      .filter((held) => this.visible(held, nodeChain))
      .map((held) => held.member)
  }

  private visible(held: Installed, nodeChain?: readonly string[]): boolean {
    return held.attach === undefined || (nodeChain?.includes(held.attach) ?? false)
  }
}

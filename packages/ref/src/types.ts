import { z, type ZodType } from "zod"

/**
 * Shared optional fields available on every ref kind.
 *
 * Mirrors the `baseEntryShape` pattern in `@agstudio/model-catalog` —
 * common cross-cutting fields live in a shared shape so per-kind schemas
 * stay focused on what's unique to that kind.
 *
 * `tags` is the per-instance tag axis (a specific ref can carry tags like
 * `["primary"]`). `collections` membership lives on the kind definition
 * itself (every `local` ref is in the `file` collection); see
 * {@link KindDefinition.collections}.
 */
export const baseRefShape = {
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
} as const

/**
 * Base collections defined by AIP-27 v1. Integrations MAY declare new
 * collections by registering kinds whose `collections` includes
 * additional names.
 */
export const BASE_COLLECTIONS = ["file", "identity", "anchor", "chain"] as const

export type BaseCollection = (typeof BASE_COLLECTIONS)[number]

/**
 * Registry of ref kinds. Augmented via TypeScript declaration merging:
 *
 * ```ts
 * declare module "@agentproto/ref" {
 *   interface RefKindRegistry {
 *     my_kind: { kind: "my_kind"; ...fields }
 *   }
 * }
 * ```
 *
 * Base kinds (local, url, git, github, ipfs, email, operator, user,
 * persona, eth_tx, ots) are merged in by `./kinds/index.ts`.
 */
export interface RefKindRegistry {}

export type RefKind = keyof RefKindRegistry & string

export type Ref<K extends RefKind = RefKind> = K extends RefKind
  ? RefKindRegistry[K]
  : never

export type AnyRef = RefKindRegistry[RefKind]

export interface ResolveContext {
  fetcher?: (url: string) => Promise<Uint8Array>
  filesystem?: {
    readFile: (path: string) => Promise<Uint8Array | null>
  }
  workspaceRoot?: string
  registries?: {
    operator?: IdentityRegistry
    user?: IdentityRegistry
    persona?: IdentityRegistry
  }
}

export interface IdentityRegistry {
  lookup: (id: string) => Promise<{ displayName: string } | null>
}

export interface ResolveResult {
  bytes?: Uint8Array
  identity?: { displayName: string; canonical: AnyRef }
}

/**
 * Definition of a single ref kind. Provided to `registerRefKind`.
 *
 * Generic over the value shape; the runtime stores definitions in a
 * shape-erased map and re-narrows at the boundary.
 */
export interface KindDefinition<V extends { kind: string }> {
  kind: V["kind"]
  /**
   * Collections this kind belongs to (e.g. `["file"]`, `["identity"]`,
   * `["anchor", "chain"]`). Used by collection-typed field constraints
   * such as `RefIn<"identity">` so consumers can declare "any identity
   * ref" without enumerating every possible kind.
   *
   * Base collections are listed in {@link BASE_COLLECTIONS}; integrations
   * MAY introduce new collection names by registering kinds with them.
   */
  collections: readonly string[]
  schema: ZodType<V>
  parse: (body: string) => V
  serialize: (value: V) => string
  resolve?: (value: V, ctx: ResolveContext) => Promise<ResolveResult>
}

/**
 * Collection-typed ref constraint. At the type level this is `AnyRef`
 * (collection membership is runtime data); at runtime, validate via
 * {@link refMatchesCollection}. Use in field signatures to express
 * intent: `signer: RefIn<"identity">` reads as "any identity-collection
 * ref" and stays correct as new identity kinds are registered.
 */
export type RefIn<_C extends string> = AnyRef

export interface RefHandle<V extends AnyRef = AnyRef> {
  readonly kind: V["kind"]
  readonly value: V
  readonly compact: string
  readonly resolvable: boolean
  resolve: (ctx: ResolveContext) => Promise<ResolveResult>
  equals: (other: RefHandle) => boolean
}

export class UnknownRefKind extends Error {
  constructor(kind: string) {
    super(`Unknown ref kind: '${kind}'`)
    this.name = "UnknownRefKind"
  }
}

export class InvalidRefBody extends Error {
  constructor(kind: string, body: string, reason: string) {
    super(`Invalid body for kind '${kind}' (${reason}): ${body}`)
    this.name = "InvalidRefBody"
  }
}

export class NotResolvable extends Error {
  constructor(kind: string) {
    super(`Ref kind '${kind}' is not resolvable`)
    this.name = "NotResolvable"
  }
}

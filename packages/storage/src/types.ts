/**
 * AIP-35 StorageDefinition + StorageHandle.
 *
 * `StorageDefinition` was generated from
 * `resources/aip-35/draft/STORAGE.schema.json` via json-schema-to-typescript.
 * `StorageHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

export type IdentityRefEntry =
  | {
      name: string
      email: string
      avatar?: string
      gpg_key?: string
      role?: string
      metadata?: {}
      [k: string]: unknown
    }
  | {
      ref: string
      role?: string
      [k: string]: unknown
    }
  | {
      file: string
      role?: string
      [k: string]: unknown
    }

/**
 * Validates the YAML frontmatter portion of an AIP-35 STORAGE.md manifest, OR the inline form embedded in any other manifest's `storage:` block. Filesystem-only — sandbox-shaped backends (e2b/modal/...) live in AIP-36 SANDBOX.md.
 */
export interface StorageDefinition {
  /**
   * Standalone-only. Identifies the doctype + version. Absent when the block is inlined in another manifest.
   */
  schema?: "storage/v1"
  /**
   * Standalone-only. Globally addressable id `@<owner-slug>/<storage-slug>`.
   */
  id?: string
  /**
   * Standalone-only. Spec version of THIS file. Bump on breaking shape change.
   */
  version?: string
  /**
   * Backend kind. Day-1 enumerated set: cloud-bucket | self-bucket | github | local-fs | dev-local | mastra-s3 | mastra-azure. Hosts MAY register additional ids; the schema accepts any non-empty string and host-side validation narrows.
   */
  provider: string
  /**
   * Provider-specific connection fields. Shape varies per provider (see AIP-35 §Provider config shapes).
   */
  config: {}
  sync?: SyncBlock
  auth?: AuthBlock
  /**
   * AIP-23 identity-ref block — commit author(s) for syncing providers (github). Supports multi-attribution (primary + co-authors).
   */
  identity?: IdentityRefEntry | [IdentityRefEntry, ...IdentityRefEntry[]]
  /**
   * Paths NOT mirrored to the backing store. Glob-ish, prefix-matched.
   */
  exclude?: string[]
  /**
   * Reject writes at the storage layer.
   */
  read_only?: boolean
  /**
   * Free-form, namespaced. Authors MAY stash adapter-specific hints under namespaced keys.
   */
  metadata?: {
    [k: string]: unknown
  }
}
/**
 * Sync semantics. Lifecycle triggers reference AIP-37 event names.
 */
export interface SyncBlock {
  mode?: "canonical" | "pull-push" | "watch"
  pull?: {
    /**
     * AIP-37 lifecycle event name. Standard: workspace-open | turn-start | manual. Aliases (per-turn, each-write) resolve via AIP-37.
     */
    on?: string
    /**
     * Cache validity for pull-push providers (e.g. github clone).
     */
    ttl_seconds?: number
  }
  commit?: {
    /**
     * AIP-37 event name. Common: each-write | per-turn | per-conversation | manual.
     */
    on?: string
    /**
     * Debounce window for each-write commit mode.
     */
    batch_window_ms?: number
    /**
     * Template for commit message. Provider-specific tokens (e.g. {{operator}}, {{summary}}).
     */
    message_template?: string
  }
  push?: {
    /**
     * AIP-37 event name. Common: per-commit | per-turn | per-conversation | manual.
     */
    on?: string
    /**
     * Github only. Where commits land.
     */
    branch_policy?: "main" | "per-conversation" | "per-turn"
    /**
     * Github only. Whether to open PRs automatically.
     */
    pr_policy?: "none" | "auto" | "manual"
  }
  conflict?: {
    policy?: "rebase" | "merge" | "abort" | "manual" | "last-writer-wins" | "split-conflicts"
  }
}
/**
 * Reference to AIP-19 SECRETS.md (or future ENV.md) for credentials.
 */
export interface AuthBlock {
  /**
   * Path or registry slug pointing to a SECRETS.md (or future ENV.md) inventory.
   */
  ref?: string
  state?: {
    /**
     * Env-var names this consumer expects to be revealed from the referenced inventory.
     */
    env?: string[]
  }
}

export type StorageHandle = Readonly<StorageDefinition>

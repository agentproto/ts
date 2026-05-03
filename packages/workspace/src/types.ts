/**
 * AIP-34 WorkspaceDefinition + WorkspaceHandle.
 *
 * `WorkspaceDefinition` was generated from
 * `resources/aip-34/draft/WORKSPACE.schema.json` via json-schema-to-typescript.
 * `WorkspaceHandle` is the readonly view of the same shape; tighten it
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
 * Validates the YAML frontmatter portion of an AIP-34 WORKSPACE.md manifest. Composes the AIP-35 STORAGE block (required), AIP-36 SANDBOX block (optional), AIP-26 CODE block (optional), AIP-23 identity-ref block (optional).
 */
export interface WorkspaceDefinition {
  schema: "workspace/v1"
  /**
   * Globally addressable id `@<owner-slug>/<workspace-slug>`. Lowercase kebab-case, immutable across the workspace's lifetime.
   */
  id: string
  /**
   * Spec version of THIS file. Bump on breaking shape change.
   */
  version: string
  /**
   * Human-readable display name.
   */
  name: string
  /**
   * One-paragraph purpose.
   */
  description?: string
  owner: {
    type: "guild" | "user" | "org"
    id: string
    /**
     * Owner-side slug. MUST match the slug suffix of the workspace `id`.
     */
    slug: string
  }
  /**
   * AIP-35 STORAGE block. Required. Inline / ref / file.
   */
  storage:
    | {
        inline: STORAGEMdFrontmatterAgentstorageV1FilesystemPolicyBlock
      }
    | {
        ref: string
      }
    | {
        file: string
      }
  /**
   * AIP-36 SANDBOX block. Optional — when absent, command-execution tools MUST be unavailable.
   */
  sandbox?:
    | {
        inline: SANDBOXMdFrontmatterAgentsandboxV1ComputeEnvironmentPolicy
      }
    | {
        ref: string
      }
    | {
        file: string
      }
  /**
   * AIP-26 CODE block. Optional — when present, the workspace IS a code-workspace / repo (codespace pattern).
   */
  code?:
    | {
        inline: {}
      }
    | {
        ref: string
      }
    | {
        file: string
      }
  /**
   * AIP-23 identity-ref — default identity for sub-blocks. Sub-blocks (storage, sandbox, code) may override.
   */
  identity?: IdentityRefEntry | [IdentityRefEntry, ...IdentityRefEntry[]]
  defaults?: {
    read_only?: boolean
    [k: string]: unknown
  }
  publish?: {
    template?: boolean
    registry?: string
    visibility?: "private" | "unlisted" | "public"
  }
  tags?: string[]
  created_at?: string
  metadata?: {
    [k: string]: unknown
  }
}
/**
 * Validates the YAML frontmatter portion of an AIP-35 STORAGE.md manifest, OR the inline form embedded in any other manifest's `storage:` block. Filesystem-only — sandbox-shaped backends (e2b/modal/...) live in AIP-36 SANDBOX.md.
 */
export interface STORAGEMdFrontmatterAgentstorageV1FilesystemPolicyBlock {
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
  identity?:
    | (
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
      )
    | [
        (
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
        ),
        ...(
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
        )[]
      ]
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
/**
 * Validates the YAML frontmatter portion of an AIP-36 SANDBOX.md manifest, OR the inline form embedded in any other manifest's `sandbox:` block. Compute-only — durable filesystem backings live in AIP-35 STORAGE.md.
 */
export interface SANDBOXMdFrontmatterAgentsandboxV1ComputeEnvironmentPolicy {
  /**
   * Standalone-only. Identifies the doctype + version. Absent when the block is inlined.
   */
  schema?: "sandbox/v1"
  /**
   * Standalone-only. Globally addressable id `@<owner-slug>/<sandbox-slug>`.
   */
  id?: string
  /**
   * Standalone-only. Spec version of THIS file.
   */
  version?: string
  /**
   * Backend kind. Day-1 enumerated set: local | mastra-e2b | mastra-modal | mastra-daytona | mastra-blaxel | node-permission. Hosts MAY register additional ids.
   */
  provider: string
  /**
   * Provider-specific connection fields. Shape varies per provider (see AIP-36 §Provider config shapes).
   */
  config: {}
  /**
   * Resource caps per command.
   */
  limits?: {
    timeout_ms?: number
    memory_mb?: number
    cpu_ms?: number
  }
  env?: {
    auth?: AuthBlock1
    /**
     * Static host env-var names to forward into the sandbox.
     */
    passthrough?: string[]
  }
  network?: {
    /**
     * Hostnames the sandbox MAY reach. Empty / missing = no egress.
     */
    egress?: string[]
  }
  /**
   * Filesystems mounted inside the sandbox at declared paths. Maps to Mastra Workspace.mounts.
   */
  mounts?: MountEntry[]
  /**
   * AIP-23 identity-ref — owner of the sandbox processes.
   */
  identity?:
    | (
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
      )
    | [
        (
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
        ),
        ...(
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
        )[]
      ]
  lifecycle?: {
    /**
     * AIP-37 event name (e.g. `idle-600` for 10 min). Provider-supported only (modal, daytona).
     */
    pause_after_idle?: string
    /**
     * AIP-37 event name (e.g. `workspace-close`).
     */
    destroy_on?: string
  }
  /**
   * Reject command execution at the sandbox layer. Read-only sandbox calls fail with `sandbox_read_only`.
   */
  read_only?: boolean
  /**
   * Free-form, namespaced. Adapter hints under `metadata.<adapter>.*`.
   */
  metadata?: {
    [k: string]: unknown
  }
}
export interface AuthBlock1 {
  ref?: string
  state?: {
    env?: string[]
  }
}
export interface MountEntry {
  /**
   * What to mount. `"workspace"` shortcut for the parent workspace storage.
   */
  source:
    | "workspace"
    | {
        ref: string
      }
    | {
        inline: STORAGEMdFrontmatterAgentstorageV1FilesystemPolicyBlock
      }
    | {
        file: string
      }
  /**
   * Absolute path inside the sandbox where the mount appears.
   */
  at: string
  mode?: "read-write" | "read-only"
}

export type WorkspaceHandle = Readonly<WorkspaceDefinition>

/**
 * @agentproto/storage-github — types.
 *
 * `GithubStorageConfig` is the AIP-35 `config` block for the `github`
 * provider. `GithubFactoryContext` is the runtime bag the workspace/corpus
 * layer passes to the `factory` slot — it carries the resolved `GITHUB_TOKEN`
 * (via the `@agentproto/secrets` broker, never inlined in config) and the
 * AIP-23 `identity` used as the git commit author.
 */

/**
 * AIP-23 identity-ref entry — the subset we use for git author attribution.
 * Mirrors `IdentityRefEntry` from `@agentproto/storage`'s internal `types.ts`
 * (which is not re-exported from the package barrel). We only need the
 * named-author variant; `ref`/`file` entries are skipped by the sync impl
 * (git needs a concrete name + email).
 */
export interface GithubIdentityRef {
  name: string
  email: string
  avatar?: string
  gpg_key?: string
  role?: string
  metadata?: Record<string, unknown>
  [k: string]: unknown
}

/** Where commits land. Mirrors AIP-35 `sync.push.branch_policy`. */
export type BranchPolicy = "main" | "per-conversation" | "per-turn"

/** Whether to open PRs automatically. Mirrors AIP-35 `sync.push.pr_policy`. */
export type PrPolicy = "none" | "auto" | "manual"

/**
 * AIP-35 `config` shape for the `github` provider. The host owns config
 * validation; `@agentproto/storage` keeps `config` opaque (`config: {}`).
 */
export interface GithubStorageConfig {
  /** HTTPS clone URL, e.g. `https://github.com/owner/repo`. Also the URL
   *  used to parse `owner`/`repo` for PR creation unless `cloneUrl` is set. */
  repoUrl: string
  /** Optional override for the actual git clone/fetch URL when it differs
   *  from `repoUrl` (e.g. a mirror or local file:// origin for tests).
   *  PR parsing always uses `repoUrl`. */
  cloneUrl?: string
  /** Where commits land. Default `main`. */
  branchPolicy?: BranchPolicy
  /** Whether to open PRs. Default `none`. */
  prPolicy?: PrPolicy
  /** Base branch to PR against. Default `main`. */
  baseBranch?: string
}

/**
 * Runtime context the workspace/corpus layer passes to the factory slot.
 * The token is resolved by the caller through `@agentproto/secrets/exposure`
 * — never stored in the config or the handle.
 */
export interface GithubFactoryContext {
  /** Absolute path to the local working tree the filesystem operates on. */
  workspaceDir: string
  /** Resolved GitHub access token (fine-grained PAT with `contents:write`
   *  and, when `prPolicy: "auto"`, `pull-requests:write`). */
  token: string
  /** AIP-23 identity — primary becomes the git author; additional entries
   *  become `Co-authored-by` trailers. Only named entries (name + email)
   *  are used; `ref`/`file`-style entries are skipped. */
  identity?: GithubIdentityRef | GithubIdentityRef[]
  /** Optional conversation/turn ids for `branchPolicy: per-conversation|per-turn`. */
  conversationId?: string
  turnId?: string
}

/**
 * `PullResult` and `PushResult` come from `@agentproto/storage`'s
 * `WorkspaceSync` contract; we re-export them for convenience.
 */
export type {
  PullResult,
  PushResult,
  PushOptions,
  SyncTree,
  WorkspaceSync,
} from "@agentproto/storage"

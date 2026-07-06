/**
 * @agentproto/storage-github — AIP-35 github `WorkspaceSync` provider.
 *
 * Plugs into `@agentproto/storage`'s `defineStorage()` the same way every
 * pull-push provider does: a `factory` returning a filesystem that also
 * implements `WorkspaceSync`, plus opaque `capabilities` metadata. Hosts
 * feature-detect the sync surface with `hasWorkspaceSync(fs)`.
 *
 * PR creation is host-side `@octokit/rest`; the `GITHUB_TOKEN` is resolved
 * by the caller through `@agentproto/secrets/exposure` and passed in the
 * factory context — never inlined in config.
 *
 * Spec: https://agentproto.sh/docs/aip-35
 */

import { defineStorage } from "@agentproto/storage"

import { createGithubFilesystem } from "./github-fs.js"
import type {
  GithubFactoryContext,
  GithubStorageConfig,
  PrPolicy,
} from "./types.js"

export type {
  GithubStorageConfig,
  GithubFactoryContext,
  BranchPolicy,
  PrPolicy,
} from "./types.js"
export type { GithubFilesystem } from "./github-fs.js"
export type { WorkspaceSync, SyncTree, PullResult, PushResult, PushOptions } from "@agentproto/storage"
export { createGithubFilesystem } from "./github-fs.js"
export { createGithubWorkspaceSync } from "./github-sync.js"
export type { GithubWorkspaceSyncOpts } from "./github-sync.js"
export { parseGithubRepo, createOctokitPrCreator } from "./pr.js"
export type { PrCreator, PrResult } from "./pr.js"
export { buildGitEnv, realGitRunner, writeAuthConfig } from "./git.js"
export type { GitRunner, GitResult, GitRunOpts } from "./git.js"

/** Capabilities metadata the registry indexes (AIP-43). */
export interface GithubCapabilities extends Record<string, unknown> {
  readonly transport: "git"
  readonly prPolicy: PrPolicy
  readonly pairsWith: "sandbox"
}

/**
 * Construct a `StorageHandle` for the github provider. The `factory` slot
 * returns a `GithubFilesystem` (which is `SyncTree & WorkspaceSync`) when
 * called with a `GithubFactoryContext` by the workspace/corpus layer.
 *
 * Example:
 * ```ts
 * const handle = defineGithubStorage({
 *   repoUrl: "https://github.com/owner/repo",
 *   branchPolicy: "per-conversation",
 *   prPolicy: "auto",
 * })
 * const fs = handle.factory({ workspaceDir, token, identity })
 * if (hasWorkspaceSync(fs)) await fs.pull(fs)
 * ```
 */
export function defineGithubStorage(config: GithubStorageConfig) {
  const capabilities: GithubCapabilities = {
    transport: "git",
    prPolicy: config.prPolicy ?? "none",
    pairsWith: "sandbox",
  }
  return defineStorage<
    (ctx: GithubFactoryContext) => ReturnType<typeof createGithubFilesystem>,
    GithubCapabilities
  >({
    provider: "github",
    config,
    factory: (ctx: GithubFactoryContext) => createGithubFilesystem(config, ctx),
    capabilities,
  })
}

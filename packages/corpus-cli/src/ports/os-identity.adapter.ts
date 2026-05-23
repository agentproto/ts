/**
 * OsIdentityAdapter — `IdentityPort` resolved from OS user + cwd.
 *
 * Local-topology identity model:
 *   - principal      = `ws://users/{os-user}`
 *   - identityTree   = [
 *       `ws://users/{os-user}`,
 *       `ws://workspaces/{workspace-dir-name}`,
 *     ]
 *
 * Roles + guilds + orgs don't exist locally — single-user, single-
 * workspace machine. Scope-policy in the corpus adapter matches
 * against this minimal tree, so AIP-10 `appliesTo` entries scoped
 * narrower than `ws://users/...` or `ws://workspaces/...` are
 * invisible to the local user. That's the intended local-topology
 * semantics: you only see what's scoped to you or your workspace.
 */

import os from "node:os"
import path from "node:path"
import type {
  CallerIdentity,
  IdentityPort,
} from "@agentproto/corpus"

export interface OsIdentityAdapterOptions {
  readonly workspaceRoot: string
  /** Override the OS user (useful for tests). Falls back to os.userInfo(). */
  readonly userOverride?: string
}

export class OsIdentityAdapter implements IdentityPort {
  private readonly cached: CallerIdentity

  constructor(opts: OsIdentityAdapterOptions) {
    // Env vars win over os.userInfo() — matches Unix convention (env is
    // explicit intent, OS detection is fallback). Also keeps tests
    // deterministic across CI environments where the OS user differs.
    const user =
      opts.userOverride ??
      process.env.USER ??
      process.env.USERNAME ??
      safeGetUser() ??
      "anonymous"
    const wsName = path.basename(opts.workspaceRoot) || "default"
    this.cached = Object.freeze({
      principal: `ws://users/${slugify(user)}`,
      identityTree: Object.freeze([
        `ws://users/${slugify(user)}`,
        `ws://workspaces/${slugify(wsName)}`,
      ]),
      displayName: user,
    })
  }

  async resolve(): Promise<CallerIdentity> {
    return this.cached
  }
}

function safeGetUser(): string | undefined {
  try {
    return os.userInfo().username
  } catch {
    return undefined
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64) || "anonymous"
}

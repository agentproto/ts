/**
 * `WorkspaceSync` impl for the github provider — `pull`/`push` backed by
 * real `git` invocations (host-side) + `@octokit/rest` for PR creation.
 *
 * # Token handling
 * The token reaches git via the `GIT_HTTP_EXTRAHEADER` env var (see
 * `git.ts:buildGitEnv`) — never on the command line, never in the repo
 * URL, never logged. `GIT_TERMINAL_PROMPT=0` makes a missing token fail
 * fast instead of hanging.
 *
 * # AIP-23 identity
 * `identity` is one or more `IdentityRefEntry` records. The primary
 * becomes the git author (`user.name` / `user.email`); the remaining
 * entries become `Co-authored-by: Name <email>` trailers. `ref`-style
 * entries (no name/email) are skipped — git needs a concrete author.
 */

import {
  assertGitOk,
  buildGitEnv,
  realGitRunner,
  writeAuthConfig,
  type GitRunner,
} from "./git.js"
import {
  buildPrText,
  createOctokitPrCreator,
  isAutoPr,
  parseGithubRepo,
  type PrCreator,
} from "./pr.js"
import type {
  BranchPolicy,
  GithubFactoryContext,
  GithubIdentityRef,
  GithubStorageConfig,
  PrPolicy,
} from "./types.js"
import type {
  PullResult,
  PushOptions,
  PushResult,
  SyncTree,
  WorkspaceSync,
} from "@agentproto/storage"

/** Extra (test-injected) deps for the sync impl. */
export interface GithubWorkspaceSyncOpts {
  gitRunner?: GitRunner
  prCreator?: PrCreator
}

const DEFAULT_BASE_BRANCH = "main"

/** Resolved config (defaults applied). */
interface ResolvedConfig {
  /** Canonical repo URL — used only to parse owner/repo for PR creation. */
  repoUrl: string
  /** URL git actually clones/pushes against. Defaults to `repoUrl`; set
   *  separately when cloning from a mirror or a local origin (tests). */
  cloneUrl: string
  branchPolicy: BranchPolicy
  prPolicy: PrPolicy
  baseBranch: string
}

function resolveConfig(config: GithubStorageConfig): ResolvedConfig {
  return {
    repoUrl: config.repoUrl,
    cloneUrl: config.cloneUrl ?? config.repoUrl,
    branchPolicy: config.branchPolicy ?? "main",
    prPolicy: config.prPolicy ?? "none",
    baseBranch: config.baseBranch ?? DEFAULT_BASE_BRANCH,
  }
}

/** Build the branch name per `branchPolicy`. */
function resolveBranch(
  policy: BranchPolicy,
  baseBranch: string,
  ctx: GithubFactoryContext,
): string {
  if (policy === "main") return baseBranch
  if (policy === "per-conversation") {
    const id = ctx.conversationId
    if (!id) {
      const suffix = `agentproto-${Date.now()}`
      return `agentproto/${suffix}`
    }
    return `agentproto/${id}`
  }
  // per-turn
  const id = ctx.turnId ?? ctx.conversationId
  if (!id) {
    return `agentproto/turn-${Date.now()}`
  }
  return `agentproto/turn-${id}`
}

/** Resolve the primary author + co-author trailers from `identity`. */
function resolveAuthors(
  identity: GithubFactoryContext["identity"],
): { name: string; email: string; trailers: readonly string[] } {
  if (!identity) {
    return {
      name: "agentproto",
      email: "agentproto@users.noreply.github.com",
      trailers: [],
    }
  }
  const entries: GithubIdentityRef[] = Array.isArray(identity) ? identity : [identity]
  const named = entries.filter(
    (e): e is GithubIdentityRef =>
      "name" in e && "email" in e &&
      typeof e.name === "string" && typeof e.email === "string",
  )
  if (named.length === 0) {
    return {
      name: "agentproto",
      email: "agentproto@users.noreply.github.com",
      trailers: [],
    }
  }
  const [primary, ...rest] = named
  if (!primary) {
    return {
      name: "agentproto",
      email: "agentproto@users.noreply.github.com",
      trailers: [],
    }
  }
  const trailers = rest.map((e) => `Co-authored-by: ${e.name} <${e.email}>`)
  return { name: primary.name, email: primary.email, trailers }
}

/**
 * Create a `WorkspaceSync` bound to `config` + `ctx`. The `tree` argument
 * to `pull`/`push` is the `SyncTree` the caller operates on — git itself
 * runs against `ctx.workspaceDir` (the working tree on disk), so the tree
 * is only used to detect "is the tree empty" on pull and to count files.
 */
export function createGithubWorkspaceSync(
  config: GithubStorageConfig,
  ctx: GithubFactoryContext,
  extra: GithubWorkspaceSyncOpts = {},
): WorkspaceSync {
  const runner = extra.gitRunner ?? realGitRunner
  const prCreator = extra.prCreator ?? createOctokitPrCreator()
  const resolved = resolveConfig(config)

  async function pull(
    tree: SyncTree,
    opts?: { force?: boolean },
  ): Promise<PullResult> {
    const { workspaceDir, token } = ctx
    // Detect an empty tree: if `.git` exists OR any file is present, skip clone.
    const existing = await tree.walk("")
    const hasGit = existing.some((p: string) => p === ".git/HEAD" || p.startsWith(".git/"))
    const populated = existing.length > 0 || hasGit

    if (populated && !opts?.force) {
      // Fetch + merge the base branch.
      const env = buildGitEnv(process.env, token)
      const fetchRes = runner(["fetch", "origin", resolved.baseBranch], {
        cwd: workspaceDir,
        env,
      })
      assertGitOk(fetchRes, "fetch")
      const mergeRes = runner(
        ["merge", `origin/${resolved.baseBranch}`, "--no-edit", "--ff-only"],
        { cwd: workspaceDir, env },
      )
      // ff-only may fail when the local branch diverged — surface as failed pull
      // per `sync.conflict.policy: abort` (the default, per the plan).
      if (!mergeRes.ok) {
        const detail = mergeRes.stderr.trim() || mergeRes.stdout.trim()
        return {
          seeded: false,
          files: 0,
          bytes: 0,
          message: `pull: merge failed (local diverged from origin/${resolved.baseBranch}): ${detail}`,
        }
      }
      const files = await tree.walk("")
      return {
        seeded: false,
        files: files.length,
        bytes: 0,
        message: `pulled origin/${resolved.baseBranch}`,
      }
    }

    // Empty tree → clone.
    const env = buildGitEnv(process.env, token)
    // Clone into workspaceDir; the dir is empty so `.` works.
    const cloneRes = runner(
      ["clone", "--branch", resolved.baseBranch, resolved.cloneUrl, "."],
      { cwd: workspaceDir, env },
    )
    if (!cloneRes.ok) {
      const detail = cloneRes.stderr.trim() || cloneRes.stdout.trim()
      return {
        seeded: false,
        files: 0,
        bytes: 0,
        message: `pull: clone failed: ${detail}`,
      }
    }
    // Stamp the auth header into `.git/config` for future push/fetch.
    writeAuthConfig(runner, workspaceDir, token)
    const files = await tree.walk("")
    return {
      seeded: true,
      files: files.length,
      bytes: 0,
      message: `cloned ${resolved.repoUrl} @ ${resolved.baseBranch}`,
    }
  }

  async function push(
    tree: SyncTree,
    opts?: PushOptions,
  ): Promise<PushResult> {
    const { workspaceDir, token } = ctx
    const env = buildGitEnv(process.env, token)
    const branch = resolveBranch(resolved.branchPolicy, resolved.baseBranch, ctx)

    // Stage all changes.
    const addRes = runner(["add", "-A"], { cwd: workspaceDir, env })
    assertGitOk(addRes, "add")

    // Check for changes.
    const statusRes = runner(["status", "--porcelain"], { cwd: workspaceDir, env })
    assertGitOk(statusRes, "status")
    if (statusRes.stdout.trim() === "") {
      return { kind: "no_changes", message: "working tree clean — nothing to push" }
    }

    // Resolve identity → author + trailers.
    const { name, email, trailers } = resolveAuthors(ctx.identity)
    // Set local user.name / user.email so the commit author is correct.
    runner(["config", "user.name", name], { cwd: workspaceDir, env })
    runner(["config", "user.email", email], { cwd: workspaceDir, env })

    // Build commit message with optional Co-authored-by trailers.
    const summary = opts?.summary ?? "agentproto sync"
    const message =
      trailers.length > 0
        ? `${summary}\n\n${trailers.join("\n")}\n`
        : `${summary}\n`

    const commitRes = runner(["commit", "-m", message], {
      cwd: workspaceDir,
      env,
    })
    assertGitOk(commitRes, "commit")

    // Branch handling — for per-conversation/per-turn, create/checkout the branch.
    if (resolved.branchPolicy !== "main") {
      // Create the branch at the current commit and check it out.
      const checkoutRes = runner(
        ["checkout", "-B", branch],
        { cwd: workspaceDir, env },
      )
      assertGitOk(checkoutRes, "checkout")
    }

    // Push.
    const pushRes = runner(["push", "-u", "origin", branch], {
      cwd: workspaceDir,
      env,
    })
    if (!pushRes.ok) {
      const detail = pushRes.stderr.trim() || pushRes.stdout.trim()
      return {
        kind: "failed",
        message: `push to origin/${branch} failed: ${detail}`,
      }
    }

    // Count files committed.
    const files = (await tree.walk("")).length

    // PR policy.
    if (resolved.branchPolicy === "main" || !isAutoPr(resolved.prPolicy)) {
      // No PR (main lands directly; manual/none just pushes).
      if (resolved.prPolicy === "manual" && resolved.branchPolicy !== "main") {
        const { title, body } = buildPrText({ label: opts?.label, summary: opts?.summary })
        return {
          kind: "pushed",
          ref: branch,
          files,
          message: `pushed to ${branch} — open PR manually: ${title}`,
          errors: [`pr_policy=manual: open PR from ${branch} → ${resolved.baseBranch} (body: ${body.slice(0, 80)}…)`],
        }
      }
      return {
        kind: "pushed",
        ref: branch,
        files,
        message: `pushed to ${branch}`,
      }
    }

    // Auto-PR via octokit.
    try {
      const { owner, repo } = parseGithubRepo(resolved.repoUrl)
      const { title, body } = buildPrText({ label: opts?.label, summary: opts?.summary })
      const pr = await prCreator.openPr({
        token,
        owner,
        repo,
        head: branch,
        base: resolved.baseBranch,
        title,
        body,
      })
      return {
        kind: "pushed",
        ref: branch,
        files,
        prUrl: pr.prUrl,
        prNumber: pr.prNumber,
        message: `pushed to ${branch} and opened PR #${pr.prNumber}`,
      }
    } catch (err) {
      // Token lacks pull-requests:write — surface the error but keep the push.
      const msg = err instanceof Error ? err.message : String(err)
      return {
        kind: "pushed",
        ref: branch,
        files,
        message: `pushed to ${branch} but PR open failed: ${msg}`,
        errors: [`pr_policy=auto: PR open failed — ${msg}`],
      }
    }
  }

  return { pull, push }
}

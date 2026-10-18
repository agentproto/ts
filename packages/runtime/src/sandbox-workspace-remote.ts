/**
 * Check a workspace's registered `remote` out inside a sandbox.
 *
 * `agent_start({ workspaceSlug, sandbox })` for a workspace carrying a
 * `remote` clones that repo into the box (the host path means nothing there),
 * optionally cuts `wt/<slug>` from a base ref, and lands the session in the
 * checkout. This module is the pure half: it turns the request into an ordered
 * list of shell steps and runs them through any `exec` seam, so it works for
 * every provider that implements `BootedSandbox.exec` and is testable with a
 * fake.
 *
 * The git token never appears in a command, URL or argv. The box receives it
 * as the env var {@link GIT_TOKEN_ENV} (resolved from the keychain by
 * `sandbox-secret-resolver`), and a credential helper configured here reads it
 * from the environment when git asks. The same token is also exposed as
 * {@link GH_TOKEN_ENV} so the `gh` CLI baked into the workstation template can
 * open pull requests with it.
 */

import { posix } from "node:path"
import type { SandboxExecOpts, SandboxExecResult, SandboxSpec } from "@agentproto/sandbox"
import { DEFAULT_REMOTE_BRANCH, validateRemoteBranch, type WorkspaceRemote } from "./workspaces-config.js"

/** Env var the box sees the git token under. */
export const GIT_TOKEN_ENV = "AGENTPROTO_GIT_TOKEN"

/** Env var `gh` reads its token from. In the box it carries the same
 *  workspace git token as {@link GIT_TOKEN_ENV}, so `gh pr create` works. */
export const GH_TOKEN_ENV = "GH_TOKEN"

const RESERVED_SANDBOX_ENV: ReadonlySet<string> = new Set([GIT_TOKEN_ENV, GH_TOKEN_ENV])

/**
 * {@link GIT_TOKEN_ENV} and {@link GH_TOKEN_ENV} are reserved for the daemon's
 * own workspace-remote injection. Drop them from any caller-declared env slot
 * (`env.passthrough`, `env.auth.state.env`, `join.tokenEnv`) so a caller can
 * neither shadow the workspace token nor pull a same-named daemon env var
 * (e.g. the operator's own `GH_TOKEN`) into the box by hand.
 */
export function withoutReservedSandboxEnv<T extends SandboxSpec>(spec: T): T {
  const keep = (names: string[] | undefined): string[] | undefined =>
    names?.filter(name => !RESERVED_SANDBOX_ENV.has(name))
  const env = spec.env
  const stripped =
    env === undefined
      ? spec
      : {
          ...spec,
          env: {
            ...env,
            ...(env.passthrough ? { passthrough: keep(env.passthrough) } : {}),
            ...(env.auth?.state?.env
              ? { auth: { ...env.auth, state: { ...env.auth.state, env: keep(env.auth.state.env) } } }
              : {}),
          },
        }
  if (stripped.join?.tokenEnv !== undefined && RESERVED_SANDBOX_ENV.has(stripped.join.tokenEnv)) {
    const { tokenEnv: _dropped, ...join } = stripped.join
    return { ...stripped, join }
  }
  return stripped
}

/**
 * Answer {@link GH_TOKEN_ENV} with the workspace git token, and only that:
 * with `gitToken` false (no workspace remote token for this box) it resolves
 * to null, and it never falls through to a daemon-env `GH_TOKEN`. Every other
 * name goes to `resolve` unchanged.
 */
export function withGhTokenAlias(
  resolve: (slug: string) => Promise<string | null>,
  gitToken: boolean,
): (slug: string) => Promise<string | null> {
  return async slug => {
    if (slug !== GH_TOKEN_ENV) return resolve(slug)
    return gitToken ? resolve(GIT_TOKEN_ENV) : null
  }
}

/** Prefix of the work branch cut inside the box (`wt/<slug>`), matching the
 *  local worktree convention. */
export const SANDBOX_BRANCH_PREFIX = "wt/"
/** Remote branch namespace holding the uncommitted-work snapshot of a work
 *  branch (`agentproto-checkpoint/wt/<slug>`, pushed by `sandbox-delivery`). */
export const CHECKPOINT_BRANCH_PREFIX = "agentproto-checkpoint/"

const CLONE_TIMEOUT_MS = 15 * 60_000
const STEP_TIMEOUT_MS = 2 * 60_000
const ERROR_TAIL_CHARS = 1_500

export interface SandboxWorkspaceRequest {
  /** The registered workspace slug — names the checkout dir under `homeDir`. */
  workspaceSlug: string
  /** The spawn attaches to a box other sessions may stay attached to
   *  (AIP-36 reuse/attach). The per-session checkout moves out of the
   *  shared per-workspace clone into its own git worktree, so concurrent
   *  sessions never switch each other's branch or mix uncommitted files.
   *  A session alone on a fresh box leaves the request unset and keeps the
   *  plain per-workspace checkout exactly as before. */
  sharedBox?: boolean
  remote: WorkspaceRemote
  /** The box's home (`SandboxProviderHandle.defaultCwd`); the clone lands in
   *  `<homeDir>/<workspaceSlug>`. */
  homeDir: string
  /** The caller's `agent_start.worktree`. Absent ⇒ a DEFAULT `wt/<slug>`
   *  work branch is minted (via {@link mintSlug}) so every box session has a
   *  delivery target and can be resumed on a fresh box. An object pins
   *  `slug`/`base`. `false` opts out: the session works on the remote's
   *  default branch with no work branch and therefore no teardown delivery. */
  worktree?: { slug?: string; base?: string } | false
  /** Mints a slug when a work branch is needed without an explicit one. */
  mintSlug: () => string
  /** Remote branch namespace the checkpoint snapshot is read back from — must
   *  match the `refPrefix` the checkpoint was pushed with. Default
   *  {@link CHECKPOINT_BRANCH_PREFIX}. */
  checkpointRefPrefix?: string
  /** Which checkpoint snapshot may be restored onto the checkout. Default
   *  `"any"`. See {@link CheckpointRestoreSnapshot}. */
  checkpointSnapshot?: CheckpointRestoreSnapshot
}

export interface SandboxSetupStep {
  label: string
  command: string
  timeoutMs: number
  /** The step's trimmed stdout is the base commit sha. */
  capturesBaseSha?: boolean
}

/** Inside a box that other sessions share, the per-workspace clone lives here
 *  under the home; each attached session gets its own git worktree of it under
 *  `<homeDir>/.worktrees/<workspaceSlug>/<slug>`. */
export const SHARED_BOX_WORKTREES_DIR = ".worktrees"

export interface SandboxWorkspacePlan {
  /** The box's home the steps run from. */
  homeDir: string
  checkoutDir: string
  /** `wt/<slug>`; undefined only when the caller opted out (`worktree: false`). */
  branch?: string
  /** The ref the work branch is cut from (`origin/<defaultBranch>` by default). */
  baseRef: string
  /** True when a token is expected in {@link GIT_TOKEN_ENV}. */
  authenticated: boolean
  /** AIP-36 shared-box per-session worktree — present only when the spawn
   *  attaches to a box other sessions may be using: `checkoutDir` is then
   *  this session's OWN worktree of `baseDir` (the per-workspace clone), the
   *  base clone stays untouched, and `lockPath` is the in-box lock file that
   *  serializes concurrent `git fetch`/`worktree add` on the shared clone. */
  sharedBox?: { baseDir: string; lockPath: string }
  steps: SandboxSetupStep[]
}

export type SandboxWorkspaceSetupResult =
  | { ok: true; baseSha: string }
  | { ok: false; step: string; message: string }

/** Which snapshot {@link restoreCheckpointSteps} may put back: `"any"` — the
 *  one on the remote, if it fits the checkout (restart on a dead box);
 *  `"none"` — none (the last checkpoint was clean, so a stale snapshot left on
 *  the remote must not resurface); `{ sha }` — only that exact snapshot commit
 *  (migrate: the one the final checkpoint just pushed). */
export type CheckpointRestoreSnapshot = "any" | "none" | { sha: string }

export interface RestoreCheckpointRequest {
  checkoutDir: string
  /** The work branch (`wt/<slug>`) already checked out in `checkoutDir`. */
  branch: string
  /** Remote branch namespace of the snapshot. Default {@link CHECKPOINT_BRANCH_PREFIX}. */
  refPrefix?: string
  snapshot?: CheckpointRestoreSnapshot
}

/**
 * Pure planner: the setup steps that put a checkpoint snapshot back on a
 * checkout whose work branch is already checked out. Commits stay commits (a
 * branch tip the old box never pushed is fast-forwarded to the snapshot's
 * parent, which the snapshot push carried along); the snapshot's tree is
 * restored as UNCOMMITTED changes. Restores only onto a clean tree and only a
 * snapshot that descends from HEAD — anything else is stale or would clobber
 * work, so it is left on the remote. The step is never fatal: the session can
 * start without it.
 */
export function restoreCheckpointSteps(req: RestoreCheckpointRequest): SandboxSetupStep[] {
  const snapshot = req.snapshot ?? "any"
  if (snapshot === "none") return []
  if (typeof snapshot === "object" && !/^[0-9a-f]{40,64}$/.test(snapshot.sha)) {
    throw new Error(`checkpoint snapshot sha "${snapshot.sha}" is not a commit id.`)
  }
  const dir = shellQuote(req.checkoutDir)
  const ckpt = shellQuote(`refs/remotes/origin/${req.refPrefix ?? CHECKPOINT_BRANCH_PREFIX}${req.branch}`)
  const exact = typeof snapshot === "object" ? ` && [ "$(git rev-parse ${ckpt})" = ${shellQuote(snapshot.sha)} ]` : ""
  const command =
    `cd ${dir} && if git show-ref --verify --quiet ${ckpt}${exact} && ` +
    `[ -z "$(git status --porcelain)" ]; ` +
    `then { { [ "$(git rev-parse ${ckpt}^)" = "$(git rev-parse HEAD)" ] || ` +
    `{ git merge-base --is-ancestor HEAD ${ckpt}^ && git merge --ff-only -q ${ckpt}^; }; } && ` +
    `git read-tree -u --reset ${ckpt} && git reset -q && echo "restored checkpoint"; } ` +
    `|| echo "checkpoint not restored"; fi`
  return [{ label: "restore-checkpoint", command, timeoutMs: STEP_TIMEOUT_MS }]
}

/** POSIX single-quote a value for safe interpolation into a shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function validateSegment(kind: string, raw: string, pattern: RegExp): string {
  if (!pattern.test(raw)) {
    throw new Error(`${kind} "${raw}" is not usable as a path or branch segment inside the box.`)
  }
  return raw
}

/** The helper git runs for `https://<host>` credentials. It echoes the env var
 *  at run time, so the config line (and every command here) carries only the
 *  variable's NAME. */
const CREDENTIAL_HELPER = `!f() { echo username=x-access-token; echo "password=$${GIT_TOKEN_ENV}"; }; f`

/** Serialize a mutating git command against other sessions' mutators on the
 *  same shared clone: acquire `flock` on `lockPath` first (best-effort — if
 *  the lock cannot be taken the command still runs, unlocked). Locking uses
 *  fd 9 inside a subshell so `script` needs no extra quoting layer. */
function flocked(lockPath: string, script: string): string {
  return `( mkdir -p ${shellQuote(posix.dirname(lockPath))} && exec 9>>${shellQuote(lockPath)} && flock 9; ${script} )`
}

/** Build the ordered setup steps. Throws a plain Error on an unusable slug,
 *  branch or base so the caller can reject the spawn before booting a box. */
export function planSandboxWorkspace(req: SandboxWorkspaceRequest): SandboxWorkspacePlan {
  const workspaceDir = validateSegment("workspace slug", req.workspaceSlug, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  const defaultBranch = validateRemoteBranch(req.remote.defaultBranch ?? DEFAULT_REMOTE_BRANCH)
  const pinned = req.worktree === false ? undefined : req.worktree
  const baseRef = validateRemoteBranch(pinned?.base ?? `origin/${defaultBranch}`)
  const branch =
    req.worktree === false
      ? undefined
      : `${SANDBOX_BRANCH_PREFIX}${validateSegment(
          "worktree slug",
          pinned?.slug ?? req.mintSlug(),
          /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
        )}`
  const home = req.homeDir.replace(/\/+$/, "")
  // AIP-36 per-session worktree: on a shared box the per-workspace clone is
  // the SHARED base and this session works in its own git worktree of it;
  // alone on a fresh box the session keeps today's plain per-workspace
  // checkout (no worktree layering, no lock, byte-identical commands).
  const shared = req.sharedBox === true
  const homeBaseDir = `${home}/${workspaceDir}`
  const worktreesRootDirectory = `${home}/${SHARED_BOX_WORKTREES_DIR}/${workspaceDir}`
  const worktreeDir =
    shared && branch !== undefined
      ? `${worktreesRootDirectory}/${branch.slice(SANDBOX_BRANCH_PREFIX.length)}`
      : undefined
  const lockPath = `${home}/${SHARED_BOX_WORKTREES_DIR}/${workspaceDir}.lock`
  const checkoutDir = worktreeDir ?? homeBaseDir
  const dir = shellQuote(checkoutDir)
  const baseDirQuoted = shellQuote(homeBaseDir)
  const authenticated = req.remote.credentialRef !== undefined
  const steps: SandboxSetupStep[] = [
    {
      label: "git-identity",
      command:
        "git config --global user.name >/dev/null 2>&1 || git config --global user.name 'agentproto'; " +
        "git config --global user.email >/dev/null 2>&1 || git config --global user.email 'agent@agentproto.invalid'",
      timeoutMs: STEP_TIMEOUT_MS,
    },
  ]
  if (authenticated) {
    const origin = new URL(req.remote.url).origin
    steps.push({
      label: "git-credential-helper",
      command: `git config --global ${shellQuote(`credential.${origin}.helper`)} ${shellQuote(CREDENTIAL_HELPER)}`,
      timeoutMs: STEP_TIMEOUT_MS,
    })
  }
  steps.push(
    {
      label: "git-clone",
      command:
        `if [ -d ${shellQuote(`${homeBaseDir}/.git`)} ]; then ${shared ? flocked(lockPath, `git -C ${baseDirQuoted} fetch --prune origin`) : `git -C ${baseDirQuoted} fetch --prune origin`}; ` +
        `else git clone -- ${shellQuote(req.remote.url)} ${baseDirQuoted}; fi`,
      timeoutMs: CLONE_TIMEOUT_MS,
    },
    {
      label: "resolve-base",
      command: `git -C ${baseDirQuoted} rev-parse --verify --quiet ${shellQuote(`${baseRef}^{commit}`)}`,
      timeoutMs: STEP_TIMEOUT_MS,
      capturesBaseSha: true,
    },
  )
  if (branch !== undefined) {
    const ref = shellQuote(branch)
    if (worktreeDir === undefined) {
      const remoteRef = `refs/remotes/origin/${branch}`
      steps.push({
        label: "git-checkout",
        // Local branch (a reused box) first, then the branch a previous box
        // pushed (a restart on a fresh box resumes its work), else cut it.
        command:
          `cd ${dir} && if git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}; ` +
          `then git checkout ${ref}; ` +
          `elif git show-ref --verify --quiet ${shellQuote(remoteRef)}; ` +
          `then git checkout -b ${ref} --track ${shellQuote(`origin/${branch}`)}; ` +
          `else git checkout -b ${ref} ${shellQuote(baseRef)}; fi`,
        timeoutMs: STEP_TIMEOUT_MS,
      })
    } else {
      steps.push({
        label: "worktree-add",
        // The session's own worktree of the shared base clone, same branch
        // precedence as the solo `git-checkout` step: an existing worktree of
        // this branch wins (a re-attach reuses it), then the pushed branch
        // (the work survives box restarts), else it is cut from `baseRef`.
        // The base clone's own checkout is left alone: its HEAD is detached
        // (it is shared scratch), never re-pointed at a session's branch.
        command: flocked(
          lockPath,
          `if [ -e ${dir}/.git ]; then git -C ${dir} checkout ${ref} 2>/dev/null; ` +
            `elif git -C ${baseDirQuoted} show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}; ` +
            `then git -C ${baseDirQuoted} checkout --detach -q && git -C ${baseDirQuoted} worktree add ${dir} ${ref}; ` +
            `elif git -C ${baseDirQuoted} show-ref --verify --quiet ${shellQuote(`refs/remotes/origin/${branch}`)}; ` +
            `then git -C ${baseDirQuoted} worktree add --track -b ${ref} ${dir} ${shellQuote(`origin/${branch}`)}; ` +
            `else git -C ${baseDirQuoted} worktree add -b ${ref} ${dir} ${shellQuote(baseRef)}; fi`,
        ),
        timeoutMs: STEP_TIMEOUT_MS,
      })
    }
    steps.push(
      ...restoreCheckpointSteps({
        checkoutDir,
        branch,
        ...(req.checkpointRefPrefix !== undefined ? { refPrefix: req.checkpointRefPrefix } : {}),
        ...(req.checkpointSnapshot !== undefined ? { snapshot: req.checkpointSnapshot } : {}),
      }),
    )
  } else {
    steps.push({
      label: "git-checkout",
      command: `git -C ${baseDirQuoted} checkout ${shellQuote(defaultBranch)}`,
      timeoutMs: STEP_TIMEOUT_MS,
    })
  }
  return {
    homeDir: home,
    checkoutDir,
    ...(branch !== undefined ? { branch } : {}),
    baseRef,
    authenticated,
    ...(worktreeDir !== undefined ? { sharedBox: { baseDir: homeBaseDir, lockPath } } : {}),
    steps,
  }
}

/** Host-only absolute-path shapes that can never resolve inside a remote
 *  sandbox's own (Linux) filesystem: macOS's `/Volumes/…` and `/Users/…`, and
 *  a Windows drive letter. Deliberately narrow — `/home/user` or `/workspace`
 *  might be exactly the box path the caller meant. */
const HOST_ONLY_PATH_PATTERNS: readonly RegExp[] = [/^\/Volumes\//, /^\/Users\//, /^[A-Za-z]:[\\/]/]

export function looksLikeHostOnlyPath(p: string): boolean {
  return HOST_ONLY_PATH_PATTERNS.some(re => re.test(p))
}

export interface BoxCwdResolution {
  /** Where the session should start inside the box. */
  cwd: string
  /** Set when the requested cwd was ignored; says why and where it landed. */
  warning?: string
}

/**
 * Interpret an `agent_start.cwd` for a sandbox spawn that also named a
 * workspace: it is a path INSIDE the box. A relative path is resolved against
 * `base` (the checkout); an absolute one must lie under the box `homeDir`.
 * The home dir itself is the provider's default and carries no preference, so
 * it resolves to `base`. Anything else — a host path (`/Users/…`), a path
 * outside the box home, a `..` escape — is ignored with a warning and the
 * session lands in `base`.
 */
export function resolveBoxCwdRequest(req: { requested: string; base: string; homeDir: string }): BoxCwdResolution {
  const home = posix.normalize(req.homeDir.replace(/\/+$/, "") || "/")
  const ignore = (why: string): BoxCwdResolution => ({
    cwd: req.base,
    warning: `agent_start: cwd "${req.requested}" ignored — ${why}; the session starts in ${req.base}.`,
  })
  if (looksLikeHostOnlyPath(req.requested)) {
    return ignore(
      `it looks like a HOST path and the sandbox has its own filesystem (pass a path relative to the checkout, or absolute under ${home})`,
    )
  }
  const resolved = posix.resolve(req.base, req.requested)
  if (resolved === home) return { cwd: req.base }
  if (!resolved.startsWith(home === "/" ? "/" : `${home}/`)) {
    return ignore(`it is outside the box home ${home}`)
  }
  return { cwd: resolved }
}

export type SandboxExec = (opts: SandboxExecOpts) => Promise<SandboxExecResult>

/** Failure detail for a step: its exit code plus the tail of stderr (or stdout). */
export function describeExecFailure(result: SandboxExecResult): string {
  const tail = (result.stderr.trim() || result.stdout.trim()).slice(-ERROR_TAIL_CHARS)
  return `exit ${result.exitCode}${tail ? `: ${tail}` : ""}`
}

/** Run the plan's steps in order through `exec`, stopping at the first failure. */
export async function runSandboxWorkspaceSetup(
  exec: SandboxExec,
  plan: SandboxWorkspacePlan,
): Promise<SandboxWorkspaceSetupResult> {
  let baseSha: string | undefined
  for (const step of plan.steps) {
    let result: SandboxExecResult
    try {
      result = await exec({
        command: step.command,
        cwd: plan.homeDir,
        env: { GIT_TERMINAL_PROMPT: "0" },
        timeoutMs: step.timeoutMs,
      })
    } catch (err) {
      return {
        ok: false,
        step: step.label,
        message: err instanceof Error ? err.message : String(err),
      }
    }
    if (result.exitCode !== 0) {
      return { ok: false, step: step.label, message: describeExecFailure(result) }
    }
    if (step.capturesBaseSha) {
      const sha = result.stdout.trim()
      if (!/^[0-9a-f]{40,64}$/.test(sha)) {
        return { ok: false, step: step.label, message: `unexpected output resolving "${plan.baseRef}"` }
      }
      baseSha = sha
    }
  }
  if (baseSha === undefined) {
    return { ok: false, step: "resolve-base", message: "the plan never resolved a base commit" }
  }
  return { ok: true, baseSha }
}

/**
 * A work branch discovered on a box AFTER spawn: the branch the agent is
 * actually sitting on, plus (when computable) the commit it forked from.
 */
export interface LearnedWorkBranch {
  /** `wt/<slug>` — only ever returned for a `wt/`-prefixed HEAD. */
  branch: string
  /** Fork point from `baseRef`; absent when git could not compute one. */
  baseSha?: string
}

/** One round trip reading the checkout's CURRENT branch and its merge-base
 *  with `baseRef`, echoed as `branch=`/`base=` lines for
 *  {@link parseLearnedWorkBranch}. */
export function buildLearnBranchCommand(checkoutDir: string, baseRef: string): string {
  const dir = shellQuote(checkoutDir)
  const ref = shellQuote(`${baseRef}^{commit}`)
  return (
    `cd ${dir} && echo "branch=$(git rev-parse --abbrev-ref HEAD)" && ` +
    `echo "base=$(git merge-base HEAD ${ref} 2>/dev/null)"`
  )
}

/** The best-effort worktree removal a session runs on DETACH from a shared
 *  box (after its own teardown delivery has checkpointed and pushed): the
 *  worktree is removed ONLY when it is clean (no uncommitted changes) and its
 *  branch is fully pushed (`origin/<branch>` covers `<branch>`); any leftover
 *  work keeps the worktree in place and SAYS SO — the surviving operators can
 *  look at it on the still-running box. Unremovable worktrees are harmless:
 *  the next spawn of the same branch slug reuses the directory. */
export function buildWorktreeRemoveCommand(input: {
  /** The shared base clone the worktree hangs off (`git worktree` runs there). */
  baseDir: string
  /** The session's own worktree directory being removed. */
  worktreeDir: string
  branch: string
  /** The shared clone's `flock` file (`planSandboxWorkspace`'s `sharedBox.lockPath`).
   *  Absent ⇒ no lock — the removal just runs unserialized. */
  lockPath?: string
}): string {
  const base = shellQuote(input.baseDir)
  const dir = shellQuote(input.worktreeDir)
  const branch = shellQuote(input.branch)
  const range = shellQuote(`refs/remotes/origin/${input.branch}..${input.branch}`)
  const script =
    `cd ${base} && ` +
    `if [ -e ${dir}/.git ]; then ` +
    `if [ -z "$(git -C ${dir} status --porcelain)" ] && ` +
    `[ "$(git rev-list --count ${range} 2>/dev/null || echo 1)" = "0" ]; then ` +
    `git worktree remove ${dir} && git worktree prune && echo "worktree removed"; ` +
    `else echo "worktree kept: uncommitted or unpushed work in ${dir}"; fi; fi`
  return input.lockPath === undefined ? script : flocked(input.lockPath, script)
}

/** Strict on purpose: only a `wt/`-prefixed branch counts, so a box sitting on
 *  the default branch or a detached HEAD records nothing. */
export function parseLearnedWorkBranch(stdout: string): LearnedWorkBranch | undefined {
  const branch = /^branch=(.+)$/m.exec(stdout)?.[1]?.trim()
  if (branch === undefined || !branch.startsWith(SANDBOX_BRANCH_PREFIX)) return undefined
  const baseSha = /^base=([0-9a-f]{40,64})$/m.exec(stdout)?.[1]
  return { branch, ...(baseSha !== undefined ? { baseSha } : {}) }
}

/** Run {@link buildLearnBranchCommand} through the box exec. Every failure mode
 *  resolves to `undefined` — learning is opportunistic, never a turn error. */
export async function learnWorkBranch(
  exec: SandboxExec,
  checkoutDir: string,
  baseRef: string,
): Promise<LearnedWorkBranch | undefined> {
  try {
    const result = await exec({
      command: buildLearnBranchCommand(checkoutDir, baseRef),
      cwd: checkoutDir,
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: STEP_TIMEOUT_MS,
    })
    if (result.exitCode !== 0) return undefined
    return parseLearnedWorkBranch(result.stdout)
  } catch {
    return undefined
  }
}

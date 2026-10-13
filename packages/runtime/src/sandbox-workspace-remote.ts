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
  remote: WorkspaceRemote
  /** The box's home (`SandboxProviderHandle.defaultCwd`); the clone lands in
   *  `<homeDir>/<workspaceSlug>`. */
  homeDir: string
  /** The caller's `agent_start.worktree`, when present. Absent ⇒ the session
   *  works on the remote's default branch with no work branch and therefore
   *  no teardown delivery. */
  worktree?: { slug?: string; base?: string }
  /** Mints a slug when `worktree` is requested without one. */
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

export interface SandboxWorkspacePlan {
  /** The box's home the steps run from. */
  homeDir: string
  checkoutDir: string
  /** `wt/<slug>`; undefined when no worktree was requested. */
  branch?: string
  /** The ref the work branch is cut from (`origin/<defaultBranch>` by default). */
  baseRef: string
  /** True when a token is expected in {@link GIT_TOKEN_ENV}. */
  authenticated: boolean
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

/** Build the ordered setup steps. Throws a plain Error on an unusable slug,
 *  branch or base so the caller can reject the spawn before booting a box. */
export function planSandboxWorkspace(req: SandboxWorkspaceRequest): SandboxWorkspacePlan {
  const workspaceDir = validateSegment("workspace slug", req.workspaceSlug, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  const defaultBranch = validateRemoteBranch(req.remote.defaultBranch ?? DEFAULT_REMOTE_BRANCH)
  const baseRef = validateRemoteBranch(req.worktree?.base ?? `origin/${defaultBranch}`)
  const branch =
    req.worktree === undefined
      ? undefined
      : `${SANDBOX_BRANCH_PREFIX}${validateSegment(
          "worktree slug",
          req.worktree.slug ?? req.mintSlug(),
          /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
        )}`
  const home = req.homeDir.replace(/\/+$/, "")
  const checkoutDir = `${home}/${workspaceDir}`
  const dir = shellQuote(checkoutDir)
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
        `if [ -d ${shellQuote(`${checkoutDir}/.git`)} ]; then git -C ${dir} fetch --prune origin; ` +
        `else git clone -- ${shellQuote(req.remote.url)} ${dir}; fi`,
      timeoutMs: CLONE_TIMEOUT_MS,
    },
    {
      label: "resolve-base",
      command: `git -C ${dir} rev-parse --verify --quiet ${shellQuote(`${baseRef}^{commit}`)}`,
      timeoutMs: STEP_TIMEOUT_MS,
      capturesBaseSha: true,
    },
  )
  if (branch !== undefined) {
    const ref = shellQuote(branch)
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
      command: `git -C ${dir} checkout ${shellQuote(defaultBranch)}`,
      timeoutMs: STEP_TIMEOUT_MS,
    })
  }
  return { homeDir: home, checkoutDir, ...(branch !== undefined ? { branch } : {}), baseRef, authenticated, steps }
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

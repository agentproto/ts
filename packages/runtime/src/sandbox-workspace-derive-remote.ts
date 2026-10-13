/**
 * Derive a sandbox clone source for a workspace that has no `remote`
 * configured in `workspaces.json`.
 *
 * `agent_start({ workspaceSlug, sandbox })` clones the workspace's registered
 * `remote` into the box. A workspace that is a plain git checkout already
 * carries the same information in its `origin`, so this module reads it
 * instead of making the operator re-enter it:
 *
 *   - only `origin` is ever consulted (never another remote);
 *   - ssh forms (`git@github.com:o/r.git`, `ssh://git@host/o/r.git`) become
 *     `https://`, and any userinfo is stripped — a URL carrying a token is
 *     never forwarded or echoed;
 *   - the workspace's registered credential (`agentproto.git.<slug>`, what
 *     `agentproto workspace remote set --token-stdin` stores) is used when it
 *     exists; without one the remote is derived only if the repository is
 *     anonymously cloneable;
 *   - the result is marked `derived` and is never written back to
 *     `workspaces.json`.
 *
 * Every refusal carries a notice saying what is missing and how to fix it.
 */

import { execFile } from "node:child_process"
import { KeychainStore } from "@agentproto/auth"
import {
  DEFAULT_REMOTE_BRANCH,
  validateRemoteBranch,
  validateRemoteUrl,
  type WorkspaceEntry,
  type WorkspaceRemote,
} from "./workspaces-config.js"

/** A remote read from the workspace's git `origin` rather than configured. */
export type DerivedWorkspaceRemote = WorkspaceRemote & { derived: true }

export interface GitResult {
  ok: boolean
  stdout: string
}

/** Runs `git <args>` in `cwd`. Injectable for tests. */
export type GitRunner = (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<GitResult>

const GIT_TIMEOUT_MS = 10_000

export const runGit: GitRunner = (args, opts) =>
  new Promise(resolve => {
    execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", GCM_INTERACTIVE: "never" },
      },
      (err, stdout) => resolve({ ok: err === null, stdout: String(stdout ?? "") }),
    )
  })

/** Keychain slot `agentproto workspace remote set --token-stdin` stores a PAT under. */
export function workspaceGitCredentialRef(slug: string): string {
  return `agentproto.git.${slug}`
}

function httpsUrl(host: string, path: string): string | undefined {
  const cleanPath = path.replace(/^\/+/, "").replace(/\/+$/, "")
  if (!host || !cleanPath) return undefined
  try {
    return validateRemoteUrl(`https://${host}/${cleanPath}`)
  } catch {
    return undefined
  }
}

/**
 * Turn any git remote URL into the credential-free `https://` form a box can
 * clone, or `undefined` when it has no https equivalent (a local path, `file:`,
 * plain `http:`). The ssh port of an `ssh://` URL is dropped (it is the ssh
 * port, not the https one); userinfo is always dropped.
 */
export function normalizeGitRemoteUrl(raw: string): string | undefined {
  const text = raw.trim()
  if (!text) return undefined
  if (!text.includes("://")) {
    // scp-like `[user@]host:path` — a single-letter host is a Windows drive.
    const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]{2,}):(.+)$/.exec(text)
    return scp ? httpsUrl(scp[1]!, scp[2]!) : undefined
  }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return undefined
  }
  switch (parsed.protocol) {
    case "ssh:":
    case "git+ssh:":
    case "git:":
      return httpsUrl(parsed.hostname, parsed.pathname)
    case "https:": {
      if (!parsed.hostname) return undefined
      const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
      return httpsUrl(host, parsed.pathname)
    }
    default:
      return undefined
  }
}

export type DeriveRemoteRefusal =
  | "not-a-git-repo"
  | "no-origin"
  | "unsupported-origin"
  | "private-without-credential"

export type DeriveRemoteResult =
  | { ok: true; remote: DerivedWorkspaceRemote; notice: string }
  | { ok: false; reason: DeriveRemoteRefusal; notice: string }

export interface DeriveRemoteDeps {
  git?: GitRunner
  /** Whether a keychain slot holds a value. Default: the OS keychain. */
  hasCredential?: (ref: string) => Promise<boolean>
  /** Whether `url` can be cloned with no credentials. Default: `git ls-remote`
   *  with credential helpers and prompts disabled. */
  isPubliclyCloneable?: (url: string) => Promise<boolean>
}

async function keychainHas(ref: string): Promise<boolean> {
  try {
    const stored = await new KeychainStore().read({ path: ref })
    return Boolean(stored?.value)
  } catch {
    return false
  }
}

function anonymousLsRemote(git: GitRunner): (url: string) => Promise<boolean> {
  return async url =>
    (
      await git(["-c", "credential.helper=", "ls-remote", "--exit-code", url, "HEAD"], {
        cwd: process.cwd(),
        timeoutMs: 15_000,
      })
    ).ok
}

async function originDefaultBranch(git: GitRunner, cwd: string): Promise<string> {
  const attempts: Array<[string[], (out: string) => string]> = [
    [["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], out => out.replace(/^origin\//, "")],
    [["rev-parse", "--abbrev-ref", "HEAD"], out => out],
  ]
  for (const [args, pick] of attempts) {
    const result = await git(args, { cwd })
    const branch = pick(result.stdout.trim())
    if (!result.ok || !branch || branch === "HEAD") continue
    try {
      return validateRemoteBranch(branch)
    } catch {
      // not usable inside a shell command in the box — try the next source
    }
  }
  return DEFAULT_REMOTE_BRANCH
}

function setRemoteHint(slug: string): string {
  return (
    `Fix: \`agentproto workspace remote set ${slug} --url https://<host>/<owner>/<repo>.git --token-stdin\` ` +
    "(stores the token in the OS keychain and persists the remote)."
  )
}

/** Read `origin` of the git checkout at `workspace.path` as a sandbox remote. */
export async function deriveWorkspaceRemote(
  workspace: Pick<WorkspaceEntry, "slug" | "path">,
  deps: DeriveRemoteDeps = {},
): Promise<DeriveRemoteResult> {
  const git = deps.git ?? runGit
  const { slug, path } = workspace
  const label = `workspace "${slug}"`

  const inside = await git(["rev-parse", "--is-inside-work-tree"], { cwd: path })
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return {
      ok: false,
      reason: "not-a-git-repo",
      notice: `${label} (${path}) is not a git repository, so no clone source could be derived from an origin.`,
    }
  }

  const origin = await git(["remote", "get-url", "origin"], { cwd: path })
  if (!origin.ok || !origin.stdout.trim()) {
    return {
      ok: false,
      reason: "no-origin",
      notice:
        `${label} is a git repository with no \`origin\` remote, so no clone source could be derived ` +
        `(other remotes are never used). Fix: \`git -C ${path} remote add origin <https-url>\`, or ` +
        `\`agentproto workspace remote set ${slug} --url <https-url>\`.`,
    }
  }

  const url = normalizeGitRemoteUrl(origin.stdout)
  if (url === undefined) {
    return {
      ok: false,
      reason: "unsupported-origin",
      notice:
        `${label}: the \`origin\` remote has no https equivalent a sandbox can clone ` +
        `(local path, file: or plain http: URL). ${setRemoteHint(slug)}`,
    }
  }

  const defaultBranch = await originDefaultBranch(git, path)
  const credentialRef = workspaceGitCredentialRef(slug)
  if (await (deps.hasCredential ?? keychainHas)(credentialRef)) {
    return {
      ok: true,
      remote: { url, defaultBranch, credentialRef, derived: true },
      notice:
        `${label} has no remote configured — cloning its git origin ${url} (branch ${defaultBranch}) ` +
        `with the stored credential ${credentialRef}. Derived for this session only; nothing was saved.`,
    }
  }

  if (await (deps.isPubliclyCloneable ?? anonymousLsRemote(git))(url)) {
    return {
      ok: true,
      remote: { url, defaultBranch, derived: true },
      notice:
        `${label} has no remote configured — cloning its public git origin ${url} (branch ${defaultBranch}) ` +
        `without a credential, so pushes from the box will fail and work is saved as a bundle on the host instead. ` +
        `${setRemoteHint(slug)}`,
    }
  }

  return {
    ok: false,
    reason: "private-without-credential",
    notice:
      `${label}: its git origin ${url} is not publicly cloneable and no credential is registered ` +
      `(keychain slot ${credentialRef} is empty). ${setRemoteHint(slug)}`,
  }
}

export type SandboxWorkspaceSource =
  | { kind: "remote"; remote: WorkspaceRemote; notices: string[] }
  | { kind: "tar"; notices: string[] }

/**
 * What a sandbox spawn for `workspace` should seed the box from: its
 * configured `remote` (untouched fast path), else one derived from its git
 * `origin`, else nothing — then the box starts empty and its working dir is
 * checkpointed by tarball (`sandbox-tar-checkpoint.ts`).
 */
export async function resolveSandboxWorkspaceSource(
  workspace: Pick<WorkspaceEntry, "slug" | "path" | "remote">,
  deps: DeriveRemoteDeps = {},
): Promise<SandboxWorkspaceSource> {
  if (workspace.remote) return { kind: "remote", remote: workspace.remote, notices: [] }
  const derived = await deriveWorkspaceRemote(workspace, deps)
  if (derived.ok) return { kind: "remote", remote: derived.remote, notices: [derived.notice] }
  return { kind: "tar", notices: [derived.notice] }
}

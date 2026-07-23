/**
 * Wraps an agent-cli child's spawn argv through the shared OS-level
 * confinement backends (`@agentproto/command-sandbox` — macOS Seatbelt /
 * Linux bubblewrap), the same backends `@agentproto/runtime`'s
 * `command_execute` tool already wraps ALLOWLISTED commands through. This
 * confines the adapter's OWN process tree — the harness-agnostic
 * enforcement an ACP permission seam can never provide, since it only sees
 * tool calls the adapter chooses to report, not what an in-process Bash
 * actually touches.
 *
 * Used by both spawn sites in this package: the long-lived ACP/MCP arm
 * (`define-agent-cli.ts`) and the per-turn print-protocol arm
 * (`protocol/print-arm.ts`).
 */

import { homedir } from "node:os"
import { join } from "node:path"
import {
  loadAdapterSpawnSandboxConfig,
  resolveCommandSandbox,
  type SandboxMode,
  type SandboxPolicy,
} from "@agentproto/command-sandbox"

/**
 * Directories OUTSIDE the workspace, under `$HOME`, that a confined adapter
 * child needs WRITE access to just to function — toolchain self-management
 * (pnpm/npm) plus the adapter's own runtime bookkeeping. Read access to
 * `~/.npmrc` etc. is covered by Seatbelt's `allow default` / bwrap's
 * ro-bind-try of system dirs already; these are specifically the
 * WRITE-needing paths, all empirically required (2026-07-22) running a REAL
 * `npx`-spawned `claude-agent-acp` child under `workspace` mode:
 *
 * - pnpm/npm toolchain: a pnpm self-update or global install fails
 *   otherwise — documented in `@agentproto/command-sandbox`'s own module
 *   doc for the `command_execute` use of these same backends.
 * - `~/.claude/session-env/<sessionId>`: Claude Code's own Bash-tool
 *   session bookkeeping directory (empty per-session dirs it creates
 *   itself) — without write access here every Bash tool call in the
 *   confined child fails with EPERM before the command even runs, since
 *   the tool can't create its own scratch dir. Narrowly scoped to
 *   `session-env` rather than all of `~/.claude` (which also holds
 *   settings/credentials this confinement should NOT grant write access
 *   to). Harmless to include for non-claude-code adapters — a directory
 *   that doesn't exist is simply not bound (bwrap `--bind-try`) / not
 *   matched (Seatbelt subpath allow on a nonexistent path is a no-op).
 */
export function defaultToolchainWritePaths(): string[] {
  const home = homedir()
  return [
    join(home, "Library", "pnpm", ".tools"), // macOS pnpm self-managed toolchain
    join(home, ".local", "share", "pnpm"), // Linux pnpm self-managed toolchain
    join(home, ".npm"), // npm cache — self-update / global installs
    join(home, ".claude", "session-env"), // claude-code's own Bash-tool session bookkeeping
  ]
}

/**
 * pnpm/npm config files OUTSIDE the workspace that need READ access — without
 * these, pnpm still limps along on its built-in defaults but prints an EPERM
 * warning on every invocation (empirically observed 2026-07-22 running
 * `pnpm --version` / `pnpm store path` inside a real confined adapter child)
 * and silently ignores whatever the operator configured there (registry
 * mirrors, auth tokens for private registries, …). Same footgun
 * `@agentproto/command-sandbox`'s own module doc already documents for the
 * `command_execute` use of these backends.
 *
 * Also covers the git/gh keychain-backed credential gap flagged by PR 6a's
 * empirical verification: under `workspace` mode, a confined `git ls-remote`
 * failed with `unable to access '~/.gitconfig': Operation not permitted` and
 * a confined `gh auth status` failed with `open '~/.config/gh/config.yml':
 * operation not permitted` — BEFORE either tool ever reached the OS
 * keychain, because their own config files live under the denied `$HOME`
 * subtree and only metadata (stat/lstat), not content, is re-allowed there.
 * Re-verified 2026-07-23: re-allowing `~/.gitconfig` + `~/.config/git` +
 * `~/.config/gh` (content read) fixes both commands; `gh auth status` then
 * still failed one more level down — `git-credential-osxkeychain get`
 * silently returned nothing under confinement (vs. a full credential record
 * unconfined) even with `~/Library/Keychains` reachable via `allow default`'s
 * mach-lookup to securityd. Adding `~/Library/Keychains` here (content read,
 * not just the mach-IPC path `allow default` already permits) fixed it: the
 * client-side keychain lookup needs to read its own keychain database file,
 * not only talk to securityd over XPC. READ-ONLY is deliberate — an agent
 * should be able to RETRIEVE a stored credential to authenticate a push, but
 * granting WRITE would let a confined process tamper with the host's real
 * keychain (`git credential-osxkeychain store/erase`); that's out of scope
 * and not needed for the push/fetch flows this gap was blocking.
 *
 * Linux has no equivalent OS keychain this backend integrates with (`gh`/git
 * there typically use libsecret/gnome-keyring over D-Bus, or a plaintext
 * `.git-credentials` store) — see `command-sandbox-wrap.ts`'s module doc for
 * the documented workaround under bwrap.
 */
export function defaultToolchainReadPaths(): string[] {
  const home = homedir()
  return [
    join(home, ".npmrc"),
    join(home, "Library", "Preferences", "pnpm", "rc"),
    join(home, ".gitconfig"), // git's own global config (credential.helper, user.*, …)
    join(home, ".config", "git"), // XDG git config fallback
    join(home, ".config", "gh"), // gh's config.yml + hosts.yml
    join(home, "Library", "Keychains"), // macOS Keychain DB — git/gh credential retrieval (read-only; see doc above)
  ]
}

export interface WrapAgentCliSpawnOptions {
  /**
   * `undefined` ⇒ this call site didn't explicitly choose a mode — falls
   * back to the workspace's `.agentproto/command-sandbox.json`
   * `adapterSpawn.mode` (or `ADAPTER_COMMAND_SANDBOX_MODE_ENV`), and only
   * stays unconfined if THAT also resolves to `undefined` (no file, no
   * `adapterSpawn` key). An explicit mode here (from `agent_start`'s
   * `commandSandbox` param) always wins over the config file — see the
   * module's config-key doc in `@agentproto/command-sandbox` for why the
   * two are independent.
   */
  mode: SandboxMode | undefined
  /** The confinement boundary — normally the session's cwd. Also the
   *  anchor `.agentproto/command-sandbox.json` is read from. */
  cwd: string
  /**
   * Extra write-capable paths beyond the default toolchain set (e.g. the
   * per-spawn `CLAUDE_CONFIG_DIR` temp dir mkdtemp'd BEFORE this spawn —
   * bwrap's `--tmpfs /tmp` would otherwise hide it on Linux). Merged with
   * (not a replacement for) the config file's own `adapterSpawn.extraWritePaths`.
   */
  extraWritePaths?: string[]
  /** Merged with the config file's own `adapterSpawn.extraReadPaths`. */
  extraReadPaths?: string[]
  /** Adapter/arm identifier for the fail-closed error message. */
  label: string
}

/**
 * Wrap `[bin, ...args]` for confined execution, or return it unchanged when
 * unconfined. FAIL-CLOSED when a mode IS configured but no backend exists
 * for this platform — mirrors `command_execute`'s own fail-closed contract
 * in `@agentproto/runtime`'s `command-tools.ts`: an operator who explicitly
 * opted into confinement believing it's active, silently getting an
 * unconfined agent-cli child that can read `~/.ssh`, is strictly worse than
 * a clear error.
 *
 * Mode resolution order: `opts.mode` (explicit `agent_start.commandSandbox`)
 * wins outright; otherwise `.agentproto/command-sandbox.json`'s
 * `adapterSpawn.mode` (itself overridable by `ADAPTER_COMMAND_SANDBOX_MODE_ENV`)
 * applies. If BOTH resolve to `undefined` (no explicit call, no config file /
 * no `adapterSpawn` key), this stays SILENT and unconfined — unlike
 * `command_execute`'s per-call warning, which fires because `off` is what
 * ITS config loader always resolves an untouched workspace TO. Here
 * `undefined` specifically means "this axis was never engaged by anyone",
 * so warning would print on every single session spawn across the whole
 * fleet by default — a real behavior change, not the "default off,
 * unchanged behaviour" this option promises. A resolved `mode: "off"`
 * (explicit call OR an `adapterSpawn` config block that opted in and picked
 * unconfined) still gets the loud warning, matching `command_execute`'s
 * reasoning that a live "off" state shouldn't fade into background noise.
 *
 * Extra read/write paths (both the caller's `opts.extraReadPaths`/
 * `extraWritePaths` and the config file's `adapterSpawn.extraReadPaths`/
 * `extraWritePaths`) always merge in on top of the built-in toolchain
 * defaults whenever confinement is active, regardless of which side chose
 * the mode — they're workspace-level exceptions, not mode-selection.
 */
export async function wrapAgentCliSpawn(
  bin: string,
  args: string[],
  opts: WrapAgentCliSpawnOptions,
): Promise<[string, string[]]> {
  const cfg = await loadAdapterSpawnSandboxConfig(opts.cwd)
  const mode = opts.mode ?? cfg.mode
  if (mode === undefined) return [bin, args]
  if (mode === "off") {
    console.error(
      `[agent-cli] ⚠ spawning '${opts.label}' UNCONFINED — no OS-level ` +
        `sandbox is active (commandSandbox mode is "off").`,
    )
    return [bin, args]
  }
  const backend = resolveCommandSandbox()
  if (!backend) {
    throw new Error(
      `agent-cli '${opts.label}': commandSandbox mode="${mode}" is configured ` +
        `but no sandbox backend is available on ${process.platform} (macOS ` +
        `needs sandbox-exec, Linux needs bwrap installed). Refusing to spawn ` +
        `unconfined — pass commandSandbox: "off" to explicitly accept ` +
        `unconfined execution, or install the missing backend.`,
    )
  }
  const policy: SandboxPolicy = {
    workspace: opts.cwd,
    extraReadPaths: [
      ...defaultToolchainReadPaths(),
      ...cfg.extraReadPaths,
      ...(opts.extraReadPaths ?? []),
    ],
    extraWritePaths: [
      ...defaultToolchainWritePaths(),
      ...cfg.extraWritePaths,
      ...(opts.extraWritePaths ?? []),
    ],
    network: mode === "strict" || cfg.network === "deny" ? "deny" : "allow",
  }
  const wrapped = backend.wrap([bin, ...args], policy)
  return [wrapped[0] ?? bin, wrapped.slice(1)]
}

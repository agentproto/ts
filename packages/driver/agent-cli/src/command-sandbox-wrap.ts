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
 */
export function defaultToolchainReadPaths(): string[] {
  const home = homedir()
  return [
    join(home, ".npmrc"),
    join(home, "Library", "Preferences", "pnpm", "rc"),
  ]
}

export interface WrapAgentCliSpawnOptions {
  /** `undefined`/`"off"` ⇒ unconfined, argv returned unchanged. */
  mode: SandboxMode | undefined
  /** The confinement boundary — normally the session's cwd. */
  cwd: string
  /**
   * Extra write-capable paths beyond the default toolchain set (e.g. the
   * per-spawn `CLAUDE_CONFIG_DIR` temp dir mkdtemp'd BEFORE this spawn —
   * bwrap's `--tmpfs /tmp` would otherwise hide it on Linux).
   */
  extraWritePaths?: string[]
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
 * `mode === undefined` (this axis never touched — true today for every
 * existing caller, since PR 6a adds no config-file/agent_start surface for
 * it yet) stays SILENT, unlike `command_execute`'s per-call warning: that
 * warns on every call because `off` is what its config loader always
 * resolves an untouched workspace TO. Here `undefined` means the caller
 * never engaged the feature at all, so warning would print on every single
 * session spawn across the whole fleet by default — a real behavior change,
 * not the "default off, unchanged behaviour" this option promises. An
 * EXPLICIT `mode: "off"` (a caller/config that resolved this axis and
 * picked unconfined on purpose) still gets the loud warning, matching
 * `command_execute`'s reasoning that a live "off" state shouldn't fade into
 * background noise.
 */
export function wrapAgentCliSpawn(
  bin: string,
  args: string[],
  opts: WrapAgentCliSpawnOptions,
): [string, string[]] {
  if (opts.mode === undefined) return [bin, args]
  if (opts.mode === "off") {
    console.error(
      `[agent-cli] ⚠ spawning '${opts.label}' UNCONFINED — no OS-level ` +
        `sandbox is active (commandSandbox mode is "off").`,
    )
    return [bin, args]
  }
  const mode = opts.mode
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
      ...(opts.extraReadPaths ?? []),
    ],
    extraWritePaths: [
      ...defaultToolchainWritePaths(),
      ...(opts.extraWritePaths ?? []),
    ],
    network: mode === "strict" ? "deny" : "allow",
  }
  const wrapped = backend.wrap([bin, ...args], policy)
  return [wrapped[0] ?? bin, wrapped.slice(1)]
}

/**
 * OS-level process confinement — macOS Seatbelt (`sandbox-exec`) and Linux
 * bubblewrap (`bwrap`) backends for wrapping a spawned argv.
 *
 * Extracted from `@agentproto/runtime`'s original `command-tools.ts`-only
 * use (which still consumes this package for `command_execute`) so
 * `@agentproto/driver-agent-cli` can wrap its OWN adapter-child spawn
 * (`define-agent-cli.ts` / `print-arm.ts`) through the identical policy and
 * backends, without creating a circular package dependency — `runtime`
 * depends on `driver-agent-cli` (it spawns adapter sessions), so
 * `driver-agent-cli` cannot depend back on `runtime`. This package has zero
 * workspace dependencies; both sides depend on it.
 *
 * The allowlist (`command-tools.ts` in `runtime`) gates WHICH binary may
 * run; this bounds what that binary (or, for the adapter-spawn use, the
 * agent-cli child itself) may READ/WRITE and — in strict mode — reach on
 * the network. It closes the residual gap where an allowlisted interpreter
 * (`bash`, `node`, `python3`, …) reads `~/.ssh/id_rsa` or exfiltrates: the
 * cwd anchor bounds the working directory, not what the process opens.
 *
 * The Seatbelt profile was validated empirically (2026-07): under it `node`
 * / `cat` read workspace files fine, `~/.ssh` reads fail with EPERM, and
 * strict mode makes network connects fail with EPERM. Re-validated 2026-07-22
 * against a REAL `npx`-spawned adapter child (`@agentclientprotocol/
 * claude-agent-acp`, the actual `claude-code` AGENT-CLI.md bin): npm's
 * arborist `lstat`s $HOME itself while resolving config and hard-fails with
 * EPERM without a metadata-only re-allow across $HOME (see
 * `buildSeatbeltProfile`) — content read/write and directory listing under
 * $HOME stay denied; only stat/lstat-class metadata is re-opened.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"

export type SandboxMode = "off" | "workspace" | "strict"

/** Per-workspace config read from `.agentproto/command-sandbox.json`. */
export interface CommandSandboxConfig {
  /**
   * - `off`       — no confinement (default; today's behavior).
   * - `workspace` — deny access to the home directory OUTSIDE the workspace
   *                 (protects ~/.ssh, ~/.aws, credentials, …); system paths
   *                 stay readable so interpreters still run. Network allowed.
   * - `strict`    — `workspace` + deny ALL network.
   */
  mode: SandboxMode
  /** Extra absolute paths to grant read access (e.g. a shared cache). */
  extraReadPaths: string[]
  /** Network policy. Forced to `deny` when `mode === "strict"`. */
  network: "deny" | "allow"
}

/** Inputs the backend needs to build a confinement for one command. */
export interface SandboxPolicy {
  workspace: string
  extraReadPaths: string[]
  /**
   * Extra absolute paths to grant READ+WRITE access, outside the
   * workspace — e.g. a toolchain's self-managed install directory
   * (`~/Library/pnpm/.tools`) or a per-spawn scratch dir created before
   * the wrap (`CLAUDE_CONFIG_DIR`'s mkdtemp'd settings dir). Unlike
   * `extraReadPaths`, these are also writable. Defaults to `[]` when
   * omitted by a caller built against the pre-`extraWritePaths` shape.
   */
  extraWritePaths?: string[]
  network: "deny" | "allow"
}

export interface CommandSandbox {
  readonly id: string
  /**
   * Wrap `argv` so the command runs confined, returning the new argv to spawn
   * (e.g. `["sandbox-exec", "-p", <profile>, ...argv]`). Never throws —
   * sandboxing is best-effort hardening, so an empty argv is returned as-is.
   */
  wrap(argv: string[], policy: SandboxPolicy): string[]
}

const CONFIG_REL = ".agentproto/command-sandbox.json"

export const DEFAULT_SANDBOX_CONFIG: CommandSandboxConfig = {
  mode: "off",
  extraReadPaths: [],
  network: "allow",
}

/**
 * Escape hatch: overrides the workspace config file's `mode` when set to a
 * valid `SandboxMode`, without editing the tracked `.agentproto/
 * command-sandbox.json`. Two directions this matters: forcing `off` when a
 * workspace has opted into `workspace`/`strict` but one call legitimately
 * needs broad access (e.g. a one-off `pnpm install`), or forcing `workspace`/
 * `strict` on for a session/CI run without committing a config file. Any
 * other value (unset, typo, empty) is ignored and the file/default applies.
 */
export const COMMAND_SANDBOX_MODE_ENV = "AGENTPROTO_COMMAND_SANDBOX_MODE"

/**
 * Load + normalize the per-workspace sandbox config. Missing file, bad JSON, or
 * an unknown mode all fall back to `off` (fail-open on config, not on
 * confinement — a broken config must not silently pretend to sandbox; that's
 * surfaced by the caller when a mode is set but no backend exists).
 * `COMMAND_SANDBOX_MODE_ENV`, when set to a valid mode, overrides whatever the
 * file (or the default) resolved to.
 */
export async function loadSandboxConfig(
  workspace: string,
): Promise<CommandSandboxConfig> {
  const path = resolve(workspace, CONFIG_REL)
  let resolved = DEFAULT_SANDBOX_CONFIG
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(
        await readFile(path, "utf8"),
      ) as Partial<CommandSandboxConfig>
      const mode: SandboxMode =
        parsed.mode === "workspace" || parsed.mode === "strict"
          ? parsed.mode
          : "off"
      const extraReadPaths = Array.isArray(parsed.extraReadPaths)
        ? parsed.extraReadPaths.filter((x): x is string => typeof x === "string")
        : []
      // strict implies network deny; workspace honors the field (default allow).
      const network: "deny" | "allow" =
        mode === "strict" || parsed.network === "deny" ? "deny" : "allow"
      resolved = { mode, extraReadPaths, network }
    } catch {
      resolved = DEFAULT_SANDBOX_CONFIG
    }
  }
  const envMode = process.env[COMMAND_SANDBOX_MODE_ENV]
  if (envMode === "off" || envMode === "workspace" || envMode === "strict") {
    return {
      ...resolved,
      mode: envMode,
      network: envMode === "strict" ? "deny" : resolved.network,
    }
  }
  return resolved
}

/** Escape a path for embedding in an SBPL string literal. */
function sbplQuote(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/**
 * Build a macOS Seatbelt (SBPL) profile for the policy. Strategy: start
 * permissive (`allow default`) so interpreters can read their runtime + system
 * libraries, then DENY the whole home directory (the crown jewels — ~/.ssh,
 * ~/.aws, credentials), then RE-ALLOW the workspace subpath, any explicit
 * extra read paths (read-only), and any explicit extra write paths
 * (read+write — e.g. a toolchain's self-managed install dir living under
 * `$HOME`, which a read-only re-allow can't satisfy). SBPL is
 * last-match-wins, so the workspace/extra re-allows override the home deny.
 * Strict mode also denies all network. Exported for testing.
 */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const home = homedir()
  const ws = resolve(policy.workspace)
  const parts = [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath "${sbplQuote(home)}"))`,
    // Metadata-only re-allow across all of $HOME (stat/lstat — existence,
    // permissions, mtime; NOT directory listing or file content, both of
    // which need file-read-data and stay denied). Empirically required
    // (2026-07): npm/npx's arborist `lstat`s ancestor directories while
    // resolving config/paths and hard-fails with EPERM on $HOME itself
    // otherwise — even for a workspace-cwd invocation that never reads
    // any OTHER file under $HOME. Without this, no npx-spawned adapter
    // (claude-agent-acp included) can even start under `workspace` mode.
    `(allow file-read-metadata (subpath "${sbplQuote(home)}"))`,
    `(allow file-read* file-write* (subpath "${sbplQuote(ws)}"))`,
  ]
  for (const extra of policy.extraReadPaths) {
    parts.push(`(allow file-read* (subpath "${sbplQuote(resolve(extra))}"))`)
  }
  for (const extra of policy.extraWritePaths ?? []) {
    parts.push(
      `(allow file-read* file-write* (subpath "${sbplQuote(resolve(extra))}"))`,
    )
  }
  if (policy.network === "deny") parts.push("(deny network*)")
  return parts.join("")
}

/** macOS Seatbelt backend — wraps argv as `sandbox-exec -p <profile> …`. */
export const seatbeltSandbox: CommandSandbox = {
  id: "seatbelt",
  wrap(argv, policy) {
    if (argv.length === 0) return argv
    return ["sandbox-exec", "-p", buildSeatbeltProfile(policy), ...argv]
  },
}

/** Read-only system directories bubblewrap binds so interpreters find their
 *  binaries + shared libraries. `--ro-bind-try` skips any that don't exist on
 *  the distro (e.g. no `/lib64` on some), so the same list is portable. */
const BWRAP_SYSTEM_DIRS: readonly string[] = [
  "/usr",
  "/usr/local",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc",
  "/opt",
]

/**
 * Build the bubblewrap argv (everything after `bwrap`). Unlike Seatbelt's
 * "deny home except workspace", bwrap is allowlist-by-construction: ONLY the
 * paths bound here are visible, so `$HOME` secrets (~/.ssh, credentials) are
 * simply absent from the mount namespace. System dirs are read-only, the
 * workspace + extra reads are bound read-only, extra writes are bound
 * read-write (`--bind-try`, not `--ro-bind-try` — e.g. a toolchain's
 * self-managed install dir, or a per-spawn scratch dir that may not exist yet
 * when the argv is built), and strict mode adds `--unshare-net` for an
 * isolated (no-connectivity) network namespace. Exported for testing.
 *
 * Empirically validated (2026-07, ubuntu container): workspace reads succeed,
 * `~/.ssh` reads fail (invisible), and `--unshare-net` makes connects fail with
 * ENETUNREACH.
 */
export function buildBwrapArgs(argv: string[], policy: SandboxPolicy): string[] {
  const ws = resolve(policy.workspace)
  const out: string[] = [
    "--die-with-parent",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ]
  for (const d of BWRAP_SYSTEM_DIRS) out.push("--ro-bind-try", d, d)
  out.push("--bind", ws, ws)
  for (const extra of policy.extraReadPaths) {
    const p = resolve(extra)
    out.push("--ro-bind-try", p, p)
  }
  for (const extra of policy.extraWritePaths ?? []) {
    const p = resolve(extra)
    out.push("--bind-try", p, p)
  }
  if (policy.network === "deny") out.push("--unshare-net")
  out.push("--", ...argv)
  return out
}

/** Linux bubblewrap backend — wraps argv as `bwrap <binds> -- …`. */
export const bwrapSandbox: CommandSandbox = {
  id: "bwrap",
  wrap(argv, policy) {
    if (argv.length === 0) return argv
    return ["bwrap", ...buildBwrapArgs(argv, policy)]
  },
}

/** Absolute path to a `bwrap` binary, or null when bubblewrap isn't installed. */
function bwrapAvailable(): boolean {
  return (
    existsSync("/usr/bin/bwrap") ||
    existsSync("/bin/bwrap") ||
    existsSync("/usr/local/bin/bwrap")
  )
}

/**
 * The confinement backend available on this host, or `null` when none applies
 * (macOS → Seatbelt, Linux → bubblewrap when installed, Windows unsupported).
 * Callers warn when a sandbox mode is configured but this returns null — so a
 * missing backend never silently pretends to confine.
 */
export function resolveCommandSandbox(): CommandSandbox | null {
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    return seatbeltSandbox
  }
  if (process.platform === "linux" && bwrapAvailable()) {
    return bwrapSandbox
  }
  return null
}

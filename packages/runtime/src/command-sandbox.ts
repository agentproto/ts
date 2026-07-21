/**
 * OS-level confinement for `command_execute` subprocesses — macOS Seatbelt
 * (phase 2) and Linux bubblewrap (phase 3) backends.
 *
 * The allowlist (`command-tools.ts`) gates WHICH binary may run; this bounds
 * what that binary may READ/WRITE and — in strict mode — reach on the network.
 * It closes the residual gap where an allowlisted interpreter (`bash`, `node`,
 * `python3`, …) reads `~/.ssh/id_rsa` or exfiltrates: the cwd anchor bounds the
 * working directory, not what the process opens.
 *
 * Opt-in per workspace via `.agentproto/command-sandbox.json`; default OFF, so
 * existing behavior is unchanged until a user explicitly enables it. Backends
 * are platform-specific — macOS Seatbelt and Linux bubblewrap (`bwrap`), each
 * selected + probed by `resolveCommandSandbox`.
 *
 * The Seatbelt profile was validated empirically (2026-07): under it `node` /
 * `cat` read workspace files fine, `~/.ssh` reads fail with EPERM, and strict
 * mode makes network connects fail with EPERM.
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
 * Load + normalize the per-workspace sandbox config. Missing file, bad JSON, or
 * an unknown mode all fall back to `off` (fail-open on config, not on
 * confinement — a broken config must not silently pretend to sandbox; that's
 * surfaced by `command-tools.ts` when a mode is set but no backend exists).
 */
export async function loadSandboxConfig(
  workspace: string,
): Promise<CommandSandboxConfig> {
  const path = resolve(workspace, CONFIG_REL)
  if (!existsSync(path)) return DEFAULT_SANDBOX_CONFIG
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
    return { mode, extraReadPaths, network }
  } catch {
    return DEFAULT_SANDBOX_CONFIG
  }
}

/** Escape a path for embedding in an SBPL string literal. */
function sbplQuote(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/**
 * Build a macOS Seatbelt (SBPL) profile for the policy. Strategy: start
 * permissive (`allow default`) so interpreters can read their runtime + system
 * libraries, then DENY the whole home directory (the crown jewels — ~/.ssh,
 * ~/.aws, credentials), then RE-ALLOW the workspace subpath and any explicit
 * extra read paths. SBPL is last-match-wins, so the workspace re-allow overrides
 * the home deny. Strict mode also denies all network. Exported for testing.
 */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const home = homedir()
  const ws = resolve(policy.workspace)
  const parts = [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath "${sbplQuote(home)}"))`,
    `(allow file-read* file-write* (subpath "${sbplQuote(ws)}"))`,
  ]
  for (const extra of policy.extraReadPaths) {
    parts.push(`(allow file-read* (subpath "${sbplQuote(resolve(extra))}"))`)
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
 * workspace + extra reads are bound, and strict mode adds `--unshare-net` for
 * an isolated (no-connectivity) network namespace. Exported for testing.
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
 * `command-tools.ts` warns when a sandbox mode is configured but this returns
 * null — so a missing backend never silently pretends to confine.
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

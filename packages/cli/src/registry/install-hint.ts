/**
 * Shared parsing for a generic ACP agent's human `install_hint` string
 * (`acp-generic.ts`'s `AcpAgentSpec.install_hint`, e.g. `"npm install -g
 * @google/gemini-cli"` or `"uv tool install mistral-vibe"`).
 *
 * Extracted out of `install-driver.ts` (the daemon `adapter_install` path)
 * so `commands/install.ts` (the CLI-direct `agentproto install <slug>` path)
 * can drive the SAME hint through its own `vendored` install step instead of
 * treating every generic ACP agent as un-installable — see the `vendored`
 * case in `runStep`. Both callers must stay in lockstep: a hint either
 * package manager understands the same way, or neither runs it.
 */

import { execFileSync } from "node:child_process"

/** Known package-manager commands a shell hint may start with, mapped to a
 *  human "how to get this tool" line for the failure message when it's
 *  missing from PATH. */
export const KNOWN_INSTALL_COMMANDS: Record<string, string> = {
  npm: "https://nodejs.org/",
  uv: "curl -LsSf https://astral.sh/uv/install.sh | sh",
  pip: "comes with Python — https://www.python.org/downloads/",
  pip3: "comes with Python 3 — https://www.python.org/downloads/",
  pipx: "pip install pipx — https://pipx.pypa.io",
  brew: "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"",
  cargo: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
  go: "https://go.dev/dl/",
}

/**
 * Pull the npm package out of an acp entry's `install_hint`
 * (`"npm install -g @google/gemini-cli"` → `"@google/gemini-cli"`). Accepts
 * both `install`/`i` and `-g`/`--global` spellings. Returns `undefined` when
 * the hint isn't an npm-global install line (a BYO-binary agent, a `brew`
 * hint, etc.) — the caller then reports it as unsupported rather than
 * guessing a package.
 */
export function parseNpmPackageFromHint(hint?: string): string | undefined {
  if (!hint) return undefined
  const m = hint.match(/npm\s+(?:i|install)\s+(?:-g|--global)\s+(\S+)/)
  return m?.[1]
}

/**
 * Parse a non-npm install hint into command + args when the command is a
 * recognized package manager. Returns `undefined` for unknown commands so the
 * caller can fall through to `unsupported` rather than blindly executing
 * arbitrary shell lines.
 */
export function parseShellHint(
  hint?: string,
): { command: string; args: string[] } | undefined {
  if (!hint) return undefined
  const parts = hint.trim().split(/\s+/)
  const cmd = parts[0]
  if (!cmd || cmd === "npm" || !(cmd in KNOWN_INSTALL_COMMANDS)) return undefined
  return { command: cmd, args: parts.slice(1) }
}

/** Is `cmd` a runnable command on PATH (`which`/`where`)? Used before
 *  shelling out to a hint's package manager so the failure message can say
 *  "uv isn't installed" instead of a raw ENOENT from the child process. */
export function commandOnPath(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: "ignore",
    })
    return true
  } catch {
    return false
  }
}
